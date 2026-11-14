/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB).
 * الجسم خام application/octet-stream — يُقسَّم داخليًا لصفوف 2MB في Turso.
 * الجزء k يُستبدل عند إعادة الرفع (قابل للتكرار بعد فشل شبكة).
 */
const { sendJson, sendError, readBinaryBody, cors } = require("../lib/respond");
const store = require("../lib/db");
const { LIMITS } = require("../lib/env");

module.exports = async (req, res) => {
  // دعم CORS preflight (رفع أجزاء من متصفح تطبيق منفصل)
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  const jobId = req.query.job;
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || !Number.isFinite(seq) || !Number.isFinite(chunk) || seq < 0 || chunk < 0) {
    return sendError(res, 400, "معطيات الرفع ناقصة — مطلوب job و seq و chunk في الاستعلام");
  }

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة");
  if (job.status !== "queued" && job.status !== "uploading") {
    return sendError(res, 409, `حالة المهمة (${job.status}) لا تسمح بالرفع`);
  }
  const source = job.sources.find((s) => s.seq === seq);
  if (!source || source.kind !== "file") return sendError(res, 404, "لا يوجد ملف بهذا الرقم seq في هذه المهمة");

  const parsed = await readBinaryBody(req, LIMITS.UPLOAD_CHUNK_BYTES);
  if (!parsed) return sendError(res, 400, "تعذر قراءة الجسم الثنائي");
  if (parsed.tooLarge) return sendError(res, 413, `حجم الجزء يتجاوز الحد المسموح (${LIMITS.UPLOAD_CHUNK_BYTES / 1024 / 1024}MB)`);
  const buffer = parsed.buffer;
  if (!buffer || buffer.length === 0) return sendError(res, 400, "الجزء فارغ");

  const expectedStart = chunk * LIMITS.UPLOAD_CHUNK_BYTES;
  const expectedLen = Math.max(0, Math.min(LIMITS.UPLOAD_CHUNK_BYTES, source.size - expectedStart));
  if (buffer.length > expectedLen) {
    return sendError(res, 400, `حجم الجزء (${buffer.length}) أكبر من المتبقي من الملف (${expectedLen})`);
  }

  try {
    await store.insertSourceChunk(jobId, seq, chunk, buffer);
  } catch (e) {
    return sendError(res, 500, `تعذر تخزين الجزء: ${e.message}`);
  }

  if (job.status === "queued") await store.updateJob(jobId, { status: "uploading" });

  // تقدم الرفع: نسبة البايتات المرفوعة لكل الملفات × 39 (قبل المعالجة)
  let uploaded = 0;
  let totalFileBytes = 0;
  for (const s of job.sources) {
    if (s.kind !== "file") continue;
    totalFileBytes += s.size;
    const { bytes } = await store.sourceChunkCount(jobId, s.seq);
    uploaded += Math.min(bytes, s.size);
  }
  if (totalFileBytes > 0) {
    await store.updateJob(jobId, { progress: Math.max(job.progress, Math.min(39, Math.round((uploaded / totalFileBytes) * 39))) });
  }

  return sendJson(res, 200, { ok: true, received: buffer.length, source: seq, chunk });
};
