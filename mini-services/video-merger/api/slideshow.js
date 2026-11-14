/**
 * POST /api/slideshow — إنشاء مهمة "صور ← فيديو رأسي 9:16 بتحريك خفيف" (بلا أي API مدفوع).
 * يقبل {"images":["url1","url2",...]} أو {"sources":[{"kind":"file","name","size","mime"},...]} أو مزيجًا.
 * معطيات إضافية اختيارية: {"clip_seconds": 15} (5–20 ثانية، الافتراضي 15).
 * القيود: من 4 إلى 8 صور؛ رابط صورة http/https مباشر؛ ملف ≤ SLIDESHOW_IMAGE_MAX_MB.
 * → 201 {jobId, imageCount, clipSeconds, statusUrl, clipUrl, mergeUrl, [uploads[]], uploadChunkBytes, expiresAt}
 * المعالجة تتم على خطوتين لكل مهمة (ضمن مهلة دوال Vercel):
 *   1) POST /api/slideshow/{id}/clip?seq=<k> لكل صورة بالترتيب — مقطع 15 ثانية بتحريك خفيف.
 *   2) POST /api/slideshow/{id}/merge — دمج المقاطع في فيديو واحد (-c copy) ورابط التحميل.
 * حالة المهمة: GET /api/slideshow/{id} أو GET /api/jobs/{id} — الناتج يُبَث من GET /api/jobs/{id}/video.
 */
const { LIMITS, VERSION, } = require("../lib/env");
const { sendJson, sendError, readJsonBody, baseUrlOf, cors } = require("../lib/respond");
const store = require("../lib/db");

module.exports = async (req, res) => {
  // دعم CORS preflight (الواجهة في تطبيق منفصل تستدعي هذه الخدمة من المتصفح)
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");

  // تنظيف كسول للمهام المنتهية عند كل إنشاء
  void store.purgeExpiredJobs().catch(() => {});

  const parsed = await readJsonBody(req);
  if (parsed.tooLarge) return sendError(res, 413, "جسم الطلب كبير جدًا");
  if (parsed.malformed) return sendError(res, 400, "جسم الطلب ليس JSON صالحًا");
  const body = parsed.body ?? {};

  // توحيد المصادر: images[] روابط أو sources[] كاملة
  let raw = [];
  if (Array.isArray(body.images)) {
    raw = body.images.map((u) => ({ kind: "url", url: u }));
  } else if (Array.isArray(body.sources)) {
    raw = body.sources;
  } else {
    return sendError(res, 400, 'يجب تمرير الصور: {"images":[...]} روابط مباشرة أو {"sources":[...]} لرفع ملفات');
  }

  const min = LIMITS.SLIDESHOW_MIN_IMAGES;
  const max = LIMITS.SLIDESHOW_MAX_IMAGES;
  if (raw.length < min) {
    return sendError(res, 400, `العرض الصوري يحتاج ${min} صور على الأقل (مررت ${raw.length})`);
  }
  if (raw.length > max) {
    return sendError(res, 400, `أقصى عدد صور للعرض الصوري هو ${max} (مررت ${raw.length})`);
  }

  // مدة المقطع: اختيارية 5–20 ثانية، الافتراضي 15
  let clipSeconds = LIMITS.SLIDESHOW_CLIP_SEC;
  if (body.clip_seconds !== undefined) {
    const cs = Number(body.clip_seconds);
    if (!Number.isFinite(cs) || cs < 5 || cs > 20) {
      return sendError(res, 400, "clip_seconds يجب أن يكون بين 5 و 20 ثانية");
    }
    clipSeconds = Math.round(cs);
  }
  if (clipSeconds * raw.length > LIMITS.MAX_TOTAL_DURATION_SEC) {
    return sendError(res, 400, `مجموع المدة (${clipSeconds * raw.length} ثانية) يتجاوز الحد المسموح (${LIMITS.MAX_TOTAL_DURATION_SEC} ثانية)`);
  }

  const base = baseUrlOf(req);
  const sources = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] ?? {};
    const kind = s.kind === "file" ? "file" : "url";
    if (kind === "url") {
      const url = String(s.url ?? "").trim();
      if (!/^https?:\/\/\S+/.test(url)) {
        return sendError(res, 400, "روابط الصور يجب أن تكون روابط مباشرة عامة (http/https)");
      }
      sources.push({ seq: i, kind, url });
    } else {
      const name = String(s.name ?? "").slice(0, 200);
      const size = Number(s.size ?? 0);
      if (!name || !Number.isFinite(size) || size <= 0) {
        return sendError(res, 400, `الصورة رقم ${i + 1}: بيانات الملف غير مكتملة (name و size مطلبان)`);
      }
      if (size > LIMITS.SLIDESHOW_IMAGE_MAX_MB * 1024 * 1024) {
        return sendError(res, 413, `حجم الصورة "${name}" يتجاوز الحد المسموح (${LIMITS.SLIDESHOW_IMAGE_MAX_MB}MB لكل صورة)`);
      }
      const mime = String(s.mime ?? "").slice(0, 100);
      if (mime && !mime.startsWith("image/")) {
        return sendError(res, 400, `الصورة "${name}" ليست ملف صورة (نوعها ${mime})`);
      }
      sources.push({ seq: i, kind, name, size, mime: mime || null });
    }
  }

  const params = {
    clipSeconds,
    width: LIMITS.SLIDESHOW_WIDTH,
    height: LIMITS.SLIDESHOW_HEIGHT,
    fps: LIMITS.SLIDESHOW_FPS,
  };

  let job;
  try {
    job = await store.createJob(sources, "slideshow", params);
  } catch (e) {
    return sendError(res, 500, `تعذر إنشاء مهمة العرض الصوري: ${e.message}`);
  }

  const out = {
    jobId: job.id,
    imageCount: sources.length,
    clipSeconds,
    output: `${LIMITS.SLIDESHOW_WIDTH}x${LIMITS.SLIDESHOW_HEIGHT} @ ${LIMITS.SLIDESHOW_FPS}fps (9:16)`,
    totalSeconds: clipSeconds * sources.length,
    statusUrl: `${base}/api/slideshow/${job.id}`,
    clipUrl: `${base}/api/slideshow/${job.id}/clip?seq=<k>`,
    mergeUrl: `${base}/api/slideshow/${job.id}/merge`,
    finalVideoUrl: `${base}/api/jobs/${job.id}/video`,
    finalDownloadUrl: `${base}/api/jobs/${job.id}/video?download=1`,
    expiresAt: job.expiresAt,
  };

  // عند وجود ملفات: روابط رفع جاهزة + حجم الجزء المطلوب (نفس آلية الدمج)
  const fileSources = sources.filter((s) => s.kind === "file");
  if (fileSources.length > 0) {
    out.uploadChunkBytes = LIMITS.UPLOAD_CHUNK_BYTES;
    out.uploads = fileSources.map((s) => ({
      seq: s.seq,
      name: s.name,
      size: s.size,
      uploadUrl: `${base}/api/upload?job=${job.id}&seq=${s.seq}&chunk=<k>`,
    }));
  }

  void VERSION;
  return sendJson(res, 201, out);
};
