/**
 * POST /api/slideshow/{id}/image?seq=<k> — خطوة توليد الصورة للمشاهد النصية (kind "prompt").
 * توليد الصورة من الوصف عبر خدمة مجانية بلا مفتاح (Pollinations) وتخزينها في source_chunks،
 * ثم تأخذها خطوة /clip لاحقًا للتحريك والترميز — فصل الخطوات يبقي كل نداء داخل مهلة دالة Vercel.
 * منطق حد الخدمة المجانية (~صورة كل 45 ثانية لكل IP):
 * - الداخل lib/imagegen ينتظر مرة واحدة إن سمحت الميزانية (~45 ثانية) ثم يعيد المحاولة.
 * - إن ظل الحد مستنزفًا → 429 {error, retryAfter} والمهمة تبقى processing (قابلة للاستئناف) — ليست فشلًا.
 * - خدمة غير متاحة (شبكة/5xx) → 503 {error, retryable:true} والمهمة تبقى processing أيضًا.
 * المصادر من نوع file/url لا تحتاج هذه الخطوة (تُنزَّل/تُجمَّع داخل /clip مباشرة).
 */
const fs = require("node:fs");
const path = require("node:path");
const { LIMITS } = require("../../../lib/env");
const { sendJson, sendError, cors } = require("../../../lib/respond");
const store = require("../../../lib/db");
const { withTmpDir } = require("../../../lib/merge");
const { generateImage, looksLikeImage } = require("../../../lib/imagegen");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST");
  const jobId = req.query.id;
  const seq = Number(req.query.seq);
  if (!jobId || !Number.isInteger(seq) || seq < 0) {
    return sendError(res, 400, "معرف المهمة ورقم المشهد seq مطلوبان في الاستعلام");
  }

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (job.type !== "slideshow") return sendError(res, 400, "هذه ليست مهمة عرض صوري");
  if (job.status === "done") return sendJson(res, 200, { ok: true, seq, cached: true, note: "المهمة مكتملة مسبقًا" });
  if (job.status === "failed") return sendError(res, 409, "المهمة فشلت سابقًا — أنشئ مهمة جديدة بدل إعادة المحاولة");

  const source = job.sources.find((s) => s.seq === seq);
  if (!source) return sendError(res, 404, `لا يوجد مشهد بالرقم seq=${seq} في هذه المهمة`);
  if (source.kind !== "prompt") {
    return sendError(res, 400, "هذه الخطوة لمشاهد prompts فقط — مصادر file/url تُجهَّز مباشرة داخل خطوة /clip");
  }

  // الصورة مولّدة سابقًا (idempotent) — يعيد نفس النتيجة بلا عدّ جديد على حصة الخدمة
  const existing = await store.sourceChunkCount(job.id, seq);
  if (existing.bytes > 0) {
    return sendJson(res, 200, { ok: true, seq, cached: true, size: existing.bytes });
  }

  await store.updateJob(job.id, { status: "processing", error: null });
  const startedAt = Date.now();

  try {
    const result = await withTmpDir(`${job.id}-gen-${seq}`, async (dir) => {
      const imgPath = path.join(dir, `gen-${seq}`);
      const gen = await generateImage(source.url, imgPath, { startedAt });
      if (gen.rateLimited) {
        return { rateLimited: true, retryAfter: gen.retryAfter, code: gen.code };
      }
      if (gen.unreachable) {
        return { unreachable: true, message: gen.message };
      }
      // تحقق نهائي من البايتات (حماية من جسم خطأ بصيغة صورة ناقصة)
      const head = Buffer.alloc(16);
      const fd = fs.openSync(imgPath, "r");
      try {
        fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (!looksLikeImage(head)) throw new Error("المولد أعاد محتوى ليس صورة صالحة");
      const buf = fs.readFileSync(imgPath);
      // تخزين بأجزاء 4MB بنفس دلالات /api/upload (كل chunkIdx يشغل صفين 2MB داخليًا) — idempotent
      const CHUNK = LIMITS.UPLOAD_CHUNK_BYTES;
      for (let k = 0; k * CHUNK < buf.length; k++) {
        await store.insertSourceChunk(job.id, seq, k, buf.subarray(k * CHUNK, Math.min((k + 1) * CHUNK, buf.length)));
      }
      return { ok: true, size: buf.length };
    });

    if (result.rateLimited) {
      // حد الخدمة المجانية مستنزف — المهمة تبقى processing وتُستأنف مع الاستدعاء القادم بعد retryAfter
      return sendJson(res, 429, {
        error: `حد الخدمة المجانية لتوليد الصور مستنزف الآن (~صورة كل 45 ثانية لكل IP) — أعد المحاولة بعد ${result.retryAfter} ثانية تقريبًا`,
        retryAfter: result.retryAfter,
        code: result.code,
        retryable: true,
      });
    }
    if (result.unreachable) {
      return sendJson(res, 503, {
        error: `${result.message} — المهمة لم تفشل وستُستأنف تلقائيًا؛ أو مرر روابط صور جاهزة عبر images أو task_ids من generate_image`,
        retryable: true,
      });
    }
    return sendJson(res, 200, { ok: true, seq, cached: false, size: result.size });
  } catch (e) {
    // خطأ غير متوقع (تخزين/قراءة) — نصف المهمة برسالة واضحة
    await store.updateJob(job.id, { status: "failed", error: `فشل توليد صورة المشهد ${seq + 1}: ${e.message}` });
    await store.db.batch([{ sql: `DELETE FROM source_chunks WHERE job_id = ? AND source_seq = ?`, args: [job.id, seq] }], "write").catch(() => {});
    return sendError(res, 500, `فشل توليد صورة المشهد ${seq + 1}: ${e.message}`);
  }
};
