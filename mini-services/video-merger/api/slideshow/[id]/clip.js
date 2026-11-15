/**
 * POST /api/slideshow/{id}/clip?seq=<k> — معالجة صورة واحدة: تحويلها لمقطع 15 ثانية (قابل للضبط 5–20)
 * رأسي 9:16 بتحريك خفيف (Ken Burns) عبر ffmpeg، ثم تخزين المقطع في Turso (clip_chunks).
 * تنفيذ كل صورة في استدعاء مستقل يبقي كل نداء داخل مهلة دالة Vercel حتى على الخطة المجانية.
 * الفشل → 500 {"error":"..."} وحالة failed للمهمة. التقدم الكلي: 40–90 حسب عدد المقاطع الجاهزة.
 */
const path = require("node:path");
const { LIMITS } = require("../../../lib/env");
const { sendJson, sendError, cors } = require("../../../lib/respond");
const store = require("../../../lib/db");
const { downloadUrl, assertSourceCount, withTmpDir } = require("../../../lib/merge");
const { assertImageBytes, makeClip, probeClip } = require("../../../lib/slideshow");

module.exports = async (req, res) => {
  // دعم CORS preflight
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  const jobId = req.query.id;
  const seq = Number(req.query.seq);
  if (!jobId || !Number.isInteger(seq) || seq < 0) {
    return sendError(res, 400, "معرف المهمة ورقم الصورة seq مطلوبان في الاستعلام");
  }

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (job.type !== "slideshow") return sendError(res, 400, "هذه مهمة دمج فيديو وليست عرضًا صوريًا");
  if (job.status === "done") return sendJson(res, 200, { ok: true, seq, note: "المهمة مكتملة مسبقًا", progress: 100 });
  if (job.status === "failed") return sendError(res, 409, "المهمة فشلت سابقًا — أنشئ مهمة جديدة بدل إعادة المحاولة");

  const n = job.sources.length;
  try {
    assertSourceCount(n);
  } catch (e) {
    await store.updateJob(job.id, { status: "failed", error: e.message });
    return sendError(res, 400, e.message);
  }
  const source = job.sources.find((s) => s.seq === seq);
  if (!source) return sendError(res, 404, `لا توجد صورة بالرقم seq=${seq} في هذه المهمة (المدى 0..${n - 1})`);

  // الصورة يجب أن تكون جاهزة: مرفوعة بالكامل (file) أو مولّدة مسبقًا (prompt)
  if (source.kind === "file") {
    const { bytes } = await store.sourceChunkCount(job.id, seq);
    if (bytes !== source.size) {
      return sendError(res, 400, `الصورة "${source.name}" لم تُرفع بالكامل (${bytes} من ${source.size} بايت)`);
    }
  } else if (source.kind === "prompt") {
    const { bytes } = await store.sourceChunkCount(job.id, seq);
    if (bytes <= 0) {
      return sendError(res, 400, `صورة المشهد ${seq + 1} غير مولّدة بعد — استدعِ POST /api/slideshow/${jobId}/image?seq=${seq} أولًا`);
    }
  }

  const clipSeconds = Number(job.params?.clipSeconds) || LIMITS.SLIDESHOW_CLIP_SEC;
  await store.updateJob(job.id, { status: "processing", error: null });

  try {
    const result = await withTmpDir(`${job.id}-${seq}`, async (dir) => {
      // 1) تهيئة الصورة محليًا (تنزيل رابط، أو تجميع ملف مرفوع/صورة مولّدة من prompts)
      const imgPath = path.join(dir, `img-${seq}`);
      if (source.kind === "url") {
        await downloadUrl(source.url, imgPath, LIMITS.SLIDESHOW_IMAGE_MAX_MB * 1024 * 1024);
      } else {
        // file: الحجم المعلن عند الرفع — prompt: نمرر 0 لنبني من كل الصفوف المخزنة
        const expected = source.kind === "file" ? source.size : 0;
        const assembled = await store.assembleSource(job.id, seq, expected, imgPath);
        if (!assembled) {
          throw new Error(source.kind === "prompt" ? "صورة المشهد غير موجودة في التخزين — أعد خطوة /image" : `الصورة "${source.name}" غير مكتملة في التخزين — أعد رفعها`);
        }
      }

      // 2) فحص البايتات: يجب أن تكون صورة مدعومة (JPG/PNG/WEBP/GIF/BMP)
      const fs = require("node:fs");
      const head = Buffer.alloc(16);
      const fd = fs.openSync(imgPath, "r");
      try {
        fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      assertImageBytes(head);

      // 3) تحريك خفيف + ترميز المقطع (تقدم هذه الصورة داخل شريحتها من المدى 40–90)
      const sliceStart = 40 + Math.round((seq * 50) / n);
      const sliceEnd = 40 + Math.round(((seq + 1) * 50) / n);
      const clipPath = path.join(dir, `clip-${seq}.mp4`);
      await makeClip(imgPath, clipPath, seq, {
        clipSec: clipSeconds,
        onProgress: (pct) => {
          const p = sliceStart + Math.round((pct * (sliceEnd - sliceStart)) / 100);
          void store.updateJob(job.id, { progress: Math.max(40, Math.min(sliceEnd, p)) }).catch(() => {});
        },
      });

      // 4) فحص المقطع ثم تخزينه في Turso
      const probe = await probeClip(clipPath);
      const expectedSec = Math.round(clipSeconds);
      if (Math.abs(probe.duration - clipSeconds) > 1.5) {
        throw new Error(`مدة المقطع الناتج (${probe.duration.toFixed(1)}ث) لا تطابق المطلوب (${clipSeconds}ث)`);
      }
      void expectedSec;
      const size = await store.saveClip(job.id, seq, fs.readFileSync(clipPath));
      return { clipSize: size, duration: probe.duration, resolution: `${probe.width}x${probe.height}` };
    });

    const clips = await store.listClips(job.id);
    const doneCount = clips.length;
    await store.updateJob(job.id, {
      progress: Math.max(job.progress, 40 + Math.round((doneCount * 50) / n)),
      error: null,
    });

    const missing = [];
    for (let i = 0; i < n; i++) if (!clips.some((c) => c.seq === i)) missing.push(i);
    return sendJson(res, 200, {
      ok: true,
      seq,
      clipSize: result.clipSize,
      clipDuration: result.duration,
      resolution: result.resolution,
      clipsReady: doneCount,
      totalImages: n,
      allClipsReady: doneCount >= n,
      progress: 40 + Math.round((doneCount * 50) / n),
      remaining: missing,
      nextStep: doneCount >= n ? `POST /api/slideshow/${job.id}/merge` : `POST /api/slideshow/${job.id}/clip?seq=<k> لكل رقم متبقٍ`,
    });
  } catch (e) {
    await store.updateJob(job.id, { status: "failed", error: `فشلت معالجة الصورة ${seq + 1}: ${e.message}` });
    // تنظيف مقطع هذا الـ seq إن كان جزئيًا
    await store
      .db.batch([{ sql: `DELETE FROM clip_chunks WHERE job_id = ? AND clip_seq = ?`, args: [job.id, seq] }], "write")
      .catch(() => {});
    return sendError(res, 500, `فشلت معالجة الصورة ${seq + 1}: ${e.message}`);
  }
};
