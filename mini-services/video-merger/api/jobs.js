/**
 * POST /api/jobs — إنشاء مهمة دمج.
 * يقبل {"videos":["url1","url2"]} أو {"sources":[{"kind":"url","url":..},{"kind":"file","name":..,"size":..,"mime":..}]}
 * → 201 {jobId, status, statusUrl, processUrl, expiresAt, [uploads[] عند وجود ملفات], uploadChunkBytes}
 */
const { LIMITS, VERSION } = require("../lib/env");
const { sendJson, sendError, readJsonBody, baseUrlOf } = require("../lib/respond");
const store = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");

  // تنظيف كسول للمهام المنتهية عند كل إنشاء
  void store.purgeExpiredJobs().catch(() => {});

  const parsed = await readJsonBody(req);
  if (parsed.tooLarge) return sendError(res, 413, "جسم الطلب كبير جدًا");
  if (parsed.malformed) return sendError(res, 400, "جسم الطلب ليس JSON صالحًا");
  const body = parsed.body ?? {};

  // توحيد المصادر: videos[] أو sources[]
  let raw = [];
  if (Array.isArray(body.videos)) {
    raw = body.videos.map((u) => ({ kind: "url", url: u }));
  } else if (Array.isArray(body.sources)) {
    raw = body.sources;
  } else {
    return sendError(res, 400, "يجب تمرير مصادر الدمج: {\"videos\":[...]} أو {\"sources\":[...]}");
  }

  if (raw.length === 0) return sendError(res, 400, "لا توجد مصادر — مرر رابطين على الأقل أو ارفع ملفات");
  if (raw.length > LIMITS.MAX_SOURCES) {
    return sendError(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.MAX_SOURCES} (خدمة الدمج تقبل ${LIMITS.MAX_SOURCES} مقاطع كحد أقصى)`);
  }

  const base = baseUrlOf(req);
  const sources = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] ?? {};
    const kind = s.kind === "file" ? "file" : "url";
    if (kind === "url") {
      const url = String(s.url ?? "").trim();
      if (!/^https?:\/\/\S+/.test(url)) return sendError(res, 400, "روابط الفيديو يجب أن تكون روابط مباشرة عامة (http/https)");
      sources.push({ seq: i, kind, url });
    } else {
      const name = String(s.name ?? "").slice(0, 200);
      const size = Number(s.size ?? 0);
      if (!name || !Number.isFinite(size) || size <= 0) return sendError(res, 400, `المصدر رقم ${i + 1}: بيانات الملف غير مكتملة (name و size مطلبان)`);
      if (size > LIMITS.SOURCE_MAX_MB * 1024 * 1024) {
        return sendError(res, 413, `حجم الملف "${name}" يتجاوز الحد المسموح (${LIMITS.SOURCE_MAX_MB}MB لكل مصدر)`);
      }
      sources.push({ seq: i, kind, name, size, mime: String(s.mime ?? "").slice(0, 100) || null });
    }
  }

  let job;
  try {
    job = await store.createJob(sources);
  } catch (e) {
    return sendError(res, 500, `تعذر إنشاء المهمة: ${e.message}`);
  }

  const statusUrl = `${base}/api/jobs/${job.id}`;
  const processUrl = `${base}/api/jobs/${job.id}/process`;

  const out = {
    jobId: job.id,
    status: job.status,
    statusUrl,
    processUrl,
    expiresAt: job.expiresAt,
  };

  // عند وجود ملفات: نرجع روابط رفع جاهزة + حجم الجزء المطلوب
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
