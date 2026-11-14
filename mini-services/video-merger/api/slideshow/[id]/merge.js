/**
 * POST /api/slideshow/{id}/merge — الدمج النهائي للمقاطع في فيديو واحد MP4.
 * تجميع كل المقاطع من Turso ثم محوّل concat مع -c copy (إعدادات ترميز متطابقة → بلا إعادة ترميز، ثوانٍ معدودة)
 * ثم حفظ الناتج في output_chunks ووضع المهمة done.
 * الناتج يُبَث ويُنزَّل من GET /api/jobs/{id}/video و ?download=1 (نفس نقاط الدمج العادي).
 */
const path = require("node:path");
const { sendJson, sendError, baseUrlOf, cors } = require("../../../lib/respond");
const store = require("../../../lib/db");
const { withTmpDir } = require("../../../lib/merge");
const { concatClips } = require("../../../lib/slideshow");

module.exports = async (req, res) => {
  // دعم CORS preflight
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرف المهمة مطلوب");

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (job.type !== "slideshow") return sendError(res, 400, "هذه مهمة دمج فيديو وليست عرضًا صوريًا");
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

  const n = job.sources.length;
  const clips = await store.listClips(job.id);
  const missing = [];
  for (let i = 0; i < n; i++) {
    const c = clips.find((x) => x.seq === i);
    if (!c || c.bytes <= 0) missing.push(i);
  }
  if (missing.length > 0) {
    return sendError(res, 400, `المقاطع غير مكتملة بعد — الصور التالية لم تُعالج: ${missing.join(", ")}`);
  }

  try {
    await store.updateJob(job.id, { status: "processing", progress: Math.max(job.progress, 90), error: null });
    const result = await withTmpDir(`${job.id}-merge`, async (dir) => {
      const localPaths = [];
      for (let i = 0; i < n; i++) {
        const p = await store.assembleClip(job.id, i, path.join(dir, `clip-${i}.mp4`));
        if (!p) throw new Error(`المقطع رقم ${i} اختفى من التخزين — أعد معالجة الصورة ${i}`);
        localPaths.push(p);
      }
      await store.updateJob(job.id, { progress: 95 });
      const out = await concatClips(localPaths, path.join(dir, "final.mp4"));
      await store.saveOutput(job.id, path.join(dir, "final.mp4"));
      return out;
    });

    // تنظيف المقاطع الوسيطة وأجزاء المصادر — الناتج النهائي فقط هو المطلوب
    await store.db
      .batch(
        [
          { sql: `DELETE FROM clip_chunks WHERE job_id = ?`, args: [job.id] },
          { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [job.id] },
        ],
        "write",
      )
      .catch(() => {});

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
    await store.updateJob(job.id, { status: "failed", error: `فشل الدمج النهائي: ${e.message}` });
    await store.db.batch([{ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [job.id] }], "write").catch(() => {});
    return sendError(res, 500, `فشل الدمج النهائي: ${e.message}`);
  }
};
