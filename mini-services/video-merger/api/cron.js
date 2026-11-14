/** GET /api/cron — حذف المهام المنتهية (Cron يومي عبر vercel.json) */
const { sendJson, sendError } = require("../lib/respond");
const store = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendError(res, 405, "طريقة غير مسموحة — استخدم GET");
  try {
    const result = await store.purgeExpiredJobs();
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendError(res, 500, `تعذر التنظيف: ${e.message}`);
  }
};
