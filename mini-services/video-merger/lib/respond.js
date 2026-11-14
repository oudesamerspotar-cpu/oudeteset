/** استجابات JSON موحدة + CORS مفتوح + قراءة الجسم (JSON أو ثنائي) + رسائل أخطاء عربية */
const { LIMITS } = require("./env");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");
}

function sendJson(res, status, obj) {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** قراءة جسم JSON — يعيد null عند JSON تالف أو جسم أكبر من الحد */
function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        resolve({ tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({ body: {} });
      try {
        resolve({ body: JSON.parse(raw) });
      } catch {
        resolve({ malformed: true });
      }
    });
    req.on("error", () => resolve({ malformed: true }));
  });
}

/** قراءة جسم ثنائي خام — يعيد null عند تجاوز الحد (رفع الأجزاء ≤4MB) */
function readBinaryBody(req, maxBytes = LIMITS.UPLOAD_CHUNK_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        finish({ tooLarge: true });
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => finish({ buffer: Buffer.concat(chunks) }));
    req.on("error", () => finish(null));
  });
}

/** بناء رابط مطلق من ترويسات الطلب (يعمل محليًا وعلى Vercel بأي دومين) */
function baseUrlOf(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers.host || "localhost";
  return `${proto}://${host}`;
}

module.exports = { cors, sendJson, sendError, readJsonBody, readBinaryBody, baseUrlOf };
