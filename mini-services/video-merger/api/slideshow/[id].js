/**
 * GET /api/slideshow/{id} — حالة مهمة العرض الصوري بالتفصيل:
 * الحالة والتقدم + الصور الجاهزة (clips) والمتبقية + روابط الخطوات التالية،
 * وعند الاكتمال: رابط الفيديو النهائي ورابط التحميل والخصائص.
 * DELETE /api/slideshow/{id} — حذف فوري شامل (نفس DELETE /api/jobs/{id}).
 */
const { sendJson, sendError, baseUrlOf, cors } = require("../../lib/respond");
const store = require("../../lib/db");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرف المهمة مطلوب");

  if (req.method === "DELETE") {
    const ok = await store.deleteJobCascade(jobId);
    if (!ok) return sendError(res, 404, "المهمة غير موجودة");
    return sendJson(res, 200, { ok: true, deleted: jobId });
  }

  if (req.method !== "GET") return sendError(res, 405, "طريقة غير مسموحة — استخدم GET أو DELETE");

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (job.type !== "slideshow") {
    return sendError(res, 400, "هذه مهمة دمج فيديو — استفسر عنها عبر /api/jobs/{id}");
  }

  const n = job.sources.length;
  const clips = await store.listClips(job.id);
  const base = baseUrlOf(req);
  const clipStates = [];
  for (let i = 0; i < n; i++) {
    const c = clips.find((x) => x.seq === i);
    const kind = job.sources[i]?.kind ?? "url";
    // لمشاهد prompts: حالة توليد الصورة (source_chunks) قبل حالة المقطع (clip_chunks)
    const imageBytes = kind === "prompt" ? (await store.sourceChunkCount(job.id, i)).bytes : 0;
    clipStates.push({
      seq: i,
      kind,
      name: job.sources[i]?.name ?? `صورة ${i + 1}`,
      imageReady: kind === "prompt" ? imageBytes > 0 : true,
      imageGenUrl: kind === "prompt" ? `${base}/api/slideshow/${job.id}/image?seq=${i}` : null,
      ready: Boolean(c && c.bytes > 0),
      size: c?.bytes ?? 0,
    });
  }

  const out = {
    jobId: job.id,
    type: "slideshow",
    mode: job.params?.mode === "prompts" ? "prompts" : "media",
    status: job.status,
    progress: job.progress,
    imageCount: n,
    clipSeconds: Number(job.params?.clipSeconds) || 15,
    clipsReady: clipStates.filter((c) => c.ready).length,
    imagesReady: clipStates.filter((c) => c.imageReady).length,
    clips: clipStates,
    imageUrl: `${base}/api/slideshow/${job.id}/image?seq=<k>`,
    clipUrl: `${base}/api/slideshow/${job.id}/clip?seq=<k>`,
    mergeUrl: `${base}/api/slideshow/${job.id}/merge`,
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
  if (job.status === "failed") out.error = job.error ?? "فشل العرض الصوري";
  return sendJson(res, 200, out);
};
