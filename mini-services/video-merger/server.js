/**
 * خادم تطوير محلي يحاكي بيئة Vercel بدقة:
 * - يحلل المسارات الديناميكية ويضعها في req.query (مثل /api/jobs/<id> → req.query.id)
 * - يحمّل .env يدويًا (عبر lib/env.js)
 * - يخدم الواجهة من public/index.html
 * التشغيل: node server.js (المنفذ الافتراضي 4000)
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { cors, sendError } = require("./lib/respond");

require("./lib/env"); // تحميل .env قبل استيراد طبقة قاعدة البيانات

const jobsHandler = require("./api/jobs");
const jobHandler = require("./api/jobs/[id]");
const processHandler = require("./api/jobs/[id]/process");
const videoHandler = require("./api/jobs/[id]/video");
const uploadHandler = require("./api/upload");
const configHandler = require("./api/config");
const cronHandler = require("./api/cron");
const slideshowHandler = require("./api/slideshow");
const slideshowIdHandler = require("./api/slideshow/[id]");
const slideshowClipHandler = require("./api/slideshow/[id]/clip");
const slideshowImageHandler = require("./api/slideshow/[id]/image");
const slideshowMergeHandler = require("./api/slideshow/[id]/merge");

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = path.join(__dirname, "public");

function serveIndex(res) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"));
  cors(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  req.query = Object.fromEntries(url.searchParams.entries()); // مثل سلوك Vercel في وضع المسارات الديناميكية

  try {
    if (req.method === "OPTIONS") {
      cors(res);
      res.statusCode = 204;
      return res.end();
    }

    if (p === "/" || p === "/index.html") return serveIndex(res);

    // التوجيه حسب المسار فقط — فحص الطريقة داخل كل معالج (مثل سلوك Vercel)
    if (p === "/api/jobs") return await jobsHandler(req, res);
    if (p === "/api/upload") return await uploadHandler(req, res);
    if (p === "/api/config") return await configHandler(req, res);
    if (p === "/api/cron") return await cronHandler(req, res);
    if (p === "/api/slideshow") return await slideshowHandler(req, res);

    // /api/slideshow/<id>/image و /clip و /merge
    let m2;
    m2 = /^\/api\/slideshow\/([^/]+)\/image$/.exec(p);
    if (m2) {
      req.query.id = decodeURIComponent(m2[1]);
      return await slideshowImageHandler(req, res);
    }
    m2 = /^\/api\/slideshow\/([^/]+)\/clip$/.exec(p);
    if (m2) {
      req.query.id = decodeURIComponent(m2[1]);
      return await slideshowClipHandler(req, res);
    }
    m2 = /^\/api\/slideshow\/([^/]+)\/merge$/.exec(p);
    if (m2) {
      req.query.id = decodeURIComponent(m2[1]);
      return await slideshowMergeHandler(req, res);
    }

    // /api/slideshow/<id>
    m2 = /^\/api\/slideshow\/([^/]+)$/.exec(p);
    if (m2) {
      req.query.id = decodeURIComponent(m2[1]);
      return await slideshowIdHandler(req, res);
    }

    // /api/jobs/<id>/process و /video
    let m = /^\/api\/jobs\/([^/]+)\/process$/.exec(p);
    if (m) {
      req.query.id = decodeURIComponent(m[1]);
      return await processHandler(req, res);
    }
    m = /^\/api\/jobs\/([^/]+)\/video$/.exec(p);
    if (m) {
      req.query.id = decodeURIComponent(m[1]);
      return await videoHandler(req, res);
    }

    // /api/jobs/<id>
    m = /^\/api\/jobs\/([^/]+)$/.exec(p);
    if (m) {
      req.query.id = decodeURIComponent(m[1]);
      return await jobHandler(req, res);
    }

    return sendError(res, 404, "المسار غير موجود");
  } catch (e) {
    console.error("[server] خطأ غير متوقع:", e);
    if (!res.headersSent) return sendError(res, 500, `خطأ داخلي غير متوقع: ${e.message}`);
    return res.end();
  }
});

server.listen(PORT, () => {
  console.log(`خدمة دمج الفيديوهات تعمل على http://127.0.0.1:${PORT} (يحاكي بيئة Vercel)`);
});
