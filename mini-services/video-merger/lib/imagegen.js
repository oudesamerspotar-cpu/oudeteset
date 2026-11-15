/**
 * توليد الصور من وصف نصي عبر خدمة مجانية بلا مفتاح — Pollinations (image.pollinations.ai).
 * حد الخدمة المجانية الحالي: صورة واحدة كل ~45 ثانية لكل IP (خطأ HTTP 402 مع retryAfter في الجسم).
 * لذلك منطق التوليد هنا:
 * - رابط حتمي (seed ثابت مشتق من المهمة + ترتيب المشهد) → أي إعادة محاولة لاحقة تعيد نفس الصورة
 *   وتُخدَم من ذاكرة Pollinations المؤقتة فورًا بلا عدّ جديد على الحصة.
 * - عند 402: يُقرأ retryAfter من الجسم؛ إن سمحت الميزانية الزمنية للخطوة ننتظر ونحاول مرة أخرى،
 *   وإلا نُعيد {rateLimited:true, retryAfter} للمُستدعي كي يقرر (انتظار خارجي ثم استدعاء جديد).
 * - أخطاء شبكة/5xx: محاولات قصيرة متباعدة ثم {unreachable:true} — خطأ مؤقت لا يفشل المهمة فورًا.
 * - التحقق النهائي: بايتات صورة فعلية (JPEG/PNG/WEBP/GIF/BMP) وحجم ضمن الحد.
 * المتغيرات: IMAGEGEN_POLLINATIONS_BASE (افتراضي https://image.pollinations.ai/prompt)،
 *            IMAGEGEN_ATTEMPT_TIMEOUT_MS (افتراضي 75000)، IMAGEGEN_MAX_WAIT_MS (افتراضي 45000).
 */
const fs = require("node:fs");
const { LIMITS } = require("./env");

const BASE = () => (process.env.IMAGEGEN_POLLINATIONS_BASE || "https://image.pollinations.ai/prompt").replace(/\/+$/, "");
const ATTEMPT_TIMEOUT_MS = () => Number(process.env.IMAGEGEN_ATTEMPT_TIMEOUT_MS) || 75_000;
const MAX_WAIT_MS = () => Number(process.env.IMAGEGEN_MAX_WAIT_MS) || 45_000;

/** تجزئة نصية بسيطة ثابتة (djb2) لاشتقاق seed حتمي من المهمة والمشهد */
function stableHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

/** بناء رابط Pollinations حتمي لوصف مشهد: seed مشتق من (seedBase + ترتيب المشهد) */
function buildImageUrl(prompt, seed, { width, height } = {}) {
  const w = width || LIMITS.SLIDESHOW_WIDTH;
  const h = height || LIMITS.SLIDESHOW_HEIGHT;
  const params = new URLSearchParams({
    width: String(w),
    height: String(h),
    seed: String(seed),
    nologo: "true",
  });
  const model = process.env.SLIDESHOW_IMAGE_MODEL;
  if (model) params.set("model", model);
  return `${BASE()}/${encodeURIComponent(prompt)}?${params.toString()}`;
}

/** فحص بايتات صورة مدعومة (نفس قائمة slideshow) */
function looksLikeImage(buffer) {
  const b = buffer.subarray(0, 16);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.toString("ascii", 8, 12) === "WEBP") return true;
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return true; // BMP
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * توليد صورة من وصف إلى ملف محلي.
 * يعيد: {ok:true, bytes, fromCache?} | {rateLimited:true, retryAfter} | {unreachable:true, message}
 */
async function generateImage(url, destPath, { maxBytes, startedAt = Date.now() } = {}) {
  const capBytes = maxBytes || LIMITS.SLIDESHOW_IMAGE_MAX_MB * 1024 * 1024;
  let lastNetworkError = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS()),
        headers: { "User-Agent": "media-generator-slideshow/1.1" },
      });
    } catch (e) {
      lastNetworkError = e instanceof Error ? e.message : String(e);
      if (attempt < 3) await sleep(2_000 * attempt); // ارتداد قصير قبل إعادة المحاولة
      continue;
    }

    // حد الخدمة المجانية (402 FREE_LIMIT): قراءة retryAfter وقرار الانتظار
    if (res.status === 402 || res.status === 429) {
      let retryAfter = 45;
      let code = "FREE_LIMIT";
      try {
        const body = await res.json();
        const err = (body && body.error) || {};
        if (typeof err.code === "string") code = err.code;
        const msg = String(err.message ?? "");
        const m = /retry after (\d+)s/i.exec(msg);
        if (m) retryAfter = Number(m[1]);
      } catch { /* جسم غير JSON — نستخدم الافتراضي */ }
      const elapsed = Date.now() - startedAt;
      const budget = MAX_WAIT_MS() - elapsed;
      // ننتظر داخل هذه الخطوة فقط إن سمحت الميزانية (نضيف هامشًا ~20 ثانية لزمن التوليد الفعلي)
      if (attempt < 3 && retryAfter * 1000 + 20_000 <= budget) {
        await sleep(retryAfter * 1000 + 1_000);
        continue;
      }
      return { rateLimited: true, retryAfter, code };
    }

    if (!res.ok) {
      lastNetworkError = `HTTP ${res.status}`;
      if (attempt < 3) await sleep(2_000 * attempt);
      continue;
    }

    // نجاح: قراءة البايتات والتحقق
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      lastNetworkError = "استجابة فارغة";
      if (attempt < 3) await sleep(2_000);
      continue;
    }
    if (buf.length > capBytes) {
      return { unreachable: true, message: `حجم الصورة المولدة (${(buf.length / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد` };
    }
    if (!looksLikeImage(buf)) {
      // قد يكون جسم خطأ JSON بصيغة 200 — نعامله كخطأ خدمة مؤقت
      lastNetworkError = "الاستجابة ليست صورة (قد تكون رسالة خطأ من الخدمة)";
      if (attempt < 3) await sleep(2_000 * attempt);
      continue;
    }
    fs.writeFileSync(destPath, buf);
    return { ok: true, bytes: buf.length };
  }

  return { unreachable: true, message: `تعذر الوصول إلى خدمة توليد الصور المجانية بعد 3 محاولات (${lastNetworkError})` };
}

module.exports = { stableHash, buildImageUrl, looksLikeImage, generateImage };
