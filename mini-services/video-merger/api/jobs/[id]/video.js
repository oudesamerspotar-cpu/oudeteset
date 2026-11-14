/**
 * GET /api/jobs/{id}/video — بث الناتج بدعم Range (206 + Content-Range) ليعمل التقديم/الترجيع،
 * و ?download=1 للتحميل المباشر كملف MP4.
 */
const { sendError } = require("../../../lib/respond");
const store = require("../../../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendError(res, 405, "طريقة غير مسموحة — استخدم GET");
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرف المهمة مطلوب");

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, "المهمة غير موجودة");
  if (job.status !== "done") return sendError(res, 409, "الناتج غير متاح بعد — حالة المهمة: " + job.status);

  const total = await store.outputSize(jobId);
  if (total === 0) return sendError(res, 404, "الناتج غير موجود (حُذف أو انتهت صلاحيته)");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=0, no-store");

  if (req.query.download === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="merged-${job.id}.mp4"`);
  }

  // تحليل ترويسة Range: bytes=start-end | bytes=start- | bytes=-suffix
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      let start;
      let end;
      if (m[1] === "") {
        // لاحقة: آخر N بايت
        const suffix = Number(m[2]);
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(end - start + 1));
        const stream = store.readOutputStream(jobId, { start, end });
        stream.pipe(res);
        stream.on("error", () => res.destroy());
        return;
      }
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.end();
    }
  }

  // بث كامل
  res.statusCode = 200;
  res.setHeader("Content-Length", String(total));
  const stream = store.readOutputStream(jobId, null);
  stream.pipe(res);
  stream.on("error", () => res.destroy());
};
