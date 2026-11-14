/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن، يستغرق ~10–15 ثانية+).
 * يسحب المصادر ← يرمّز ← يخزن الناتج في Turso (صفوف 2MB) ويرجع مباشرة نتيجة done.
 * لو المهمة قيد المعالجة فعله يرجع 202. الفشل → 500 {"error":"..."} وحالة failed في القاعدة.
 */
const path = require("node:path");
const { LIMITS } = require("../../../lib/env");
const { sendJson, sendError, baseUrlOf } = require("../../../lib/respond");
const store = require("../../../lib/db");
const { downloadUrl, mergeLocalFiles, assertSourceCount, withTmpDir } = require("../../../lib/merge");

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرف المهمة مطلوب");

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

  if (job.status === "processing") return sendJson(res, 202, { status: "processing", progress: job.progress });
  if (job.status === "done") {
    const base = baseUrlOf(req);
    return sendJson(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${job.id}/video`,
      downloadUrl: `${base}/api/jobs/${job.id}/video?download=1`,
      size: job.size,
      duration: job.duration,
      resolution: job.resolution,
      expiresAt: job.expiresAt,
    });
  }
  if (job.status === "failed") return sendError(res, 409, "المهمة فشلت سابقًا — أنشئ مهمة جديدة بدل إعادة المحاولة");

  try {
    assertSourceCount(job.sources.length);
  } catch (e) {
    await store.updateJob(job.id, { status: "failed", error: e.message });
    return sendError(res, 400, e.message);
  }

  // التحقق من اكتمال رفع ملفات المصادر قبل البدء
  for (const s of job.sources) {
    if (s.kind !== "file") continue;
    const { bytes } = await store.sourceChunkCount(job.id, s.seq);
    if (bytes !== s.size) {
      return sendError(res, 400, `الملف "${s.name}" لم يُرفع بالكامل (${bytes} من ${s.size} بايت)`);
    }
  }

  await store.updateJob(job.id, { status: "processing", progress: 3, error: null });

  try {
    const result = await withTmpDir(job.id, async (dir) => {
      const localPaths = [];
      for (const s of job.sources) {
        const dest = path.join(dir, `src-${s.seq}.bin`);
        if (s.kind === "url") {
          await store.updateJob(job.id, { progress: 5 });
          await downloadUrl(s.url, dest, LIMITS.SOURCE_MAX_MB * 1024 * 1024);
        } else {
          const assembled = await store.assembleSource(job.id, s.seq, s.size, dest);
          if (!assembled) throw new Error(`الملف "${s.name}" غير مكتمل في التخزين — أعد رفع الأجزاء`);
        }
        localPaths.push(dest);
      }

      // الدمج نفسه — التقدم من 40 إلى 90 يُحدَّث من داخل المحرك
      const merged = await mergeLocalFiles(job.id, localPaths, path.join(dir, "out.mp4"), (p) => {
        void store.updateJob(job.id, { progress: p }).catch(() => {});
      });

      await store.updateJob(job.id, { progress: 92 });
      await store.saveOutput(job.id, path.join(dir, "out.mp4"));

      // بعد نجاح الدمج نحذف source_chunks — الناتج فقط هو المطلوب
      await store.db.batch(
        [{ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [job.id] }],
        "write",
      );

      return merged;
    });

    await store.updateJob(job.id, {
      status: "done",
      progress: 100,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
    });

    const base = baseUrlOf(req);
    return sendJson(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${job.id}/video`,
      downloadUrl: `${base}/api/jobs/${job.id}/video?download=1`,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: job.expiresAt,
    });
  } catch (e) {
    await store.updateJob(job.id, { status: "failed", error: e.message });
    // تنظيف أي ناتج جزئي
    await store.db.batch([{ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [job.id] }], "write").catch(() => {});
    return sendError(res, 500, e.message);
  }
};

void LIMITS;
