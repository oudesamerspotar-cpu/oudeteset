/**
 * GET  /api/jobs/{id} — الحالة + التقدم (0–100) + الرابط عند الاكتمال.
 * DELETE /api/jobs/{id} — حذف فوري شامل (المهمة + المصادر + الأجزاء + الناتج).
 */
const { sendJson, sendError, baseUrlOf } = require("../../lib/respond");
const store = require("../../lib/db");

module.exports = async (req, res) => {
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرف المهمة مطلوب");

  if (req.method === "GET") {
    const job = await store.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    const base = baseUrlOf(req);
    const out = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      expiresAt: job.expiresAt,
      createdAt: job.createdAt,
    };
    if (job.status === "done") {
      out.videoUrl = `${base}/api/jobs/${job.id}/video`;
      out.downloadUrl = `${base}/api/jobs/${job.id}/video?download=1`;
      out.size = job.size;
      out.duration = job.duration;
      out.resolution = job.resolution;
    }
    if (job.status === "failed") out.error = job.error ?? "فشل الدمج";
    return sendJson(res, 200, out);
  }

  if (req.method === "DELETE") {
    const ok = await store.deleteJobCascade(jobId);
    if (!ok) return sendError(res, 404, "المهمة غير موجودة");
    return sendJson(res, 200, { ok: true, deleted: jobId });
  }

  return sendError(res, 405, "طريقة غير مسموحة — استخدم GET أو DELETE");
};
