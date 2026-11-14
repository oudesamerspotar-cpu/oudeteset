/** إعدادات وحدود الخدمة — كلها قابلة للضبط بمتغيرات البيئة */
const path = require("node:path");
const fs = require("node:fs");

/** تحميل .env يدويًا (بدون dotenv) — كما في بيئة Vercel حيث تُحقن القيم مباشرة */
function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

const intEnv = (name, def) => {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const LIMITS = {
  MAX_SOURCES: intEnv("MAX_SOURCES", 10),
  SOURCE_MAX_MB: intEnv("SOURCE_MAX_MB", 200),
  OUTPUT_MAX_MB: intEnv("OUTPUT_MAX_MB", 150),
  MAX_TOTAL_DURATION_SEC: intEnv("MAX_TOTAL_DURATION_SEC", 600),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
  // رفع أجزاء 4MB لتفادي حد حجم الطلب في Vercel (~4.5MB)
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024,
  // كل Blob يُقسَّم إلى صفوف 2MB (حد عملي مريح لحجم الطلب في Turso)
  BLOB_ROW_BYTES: 2 * 1024 * 1024,
  // الصفوف تُقرأ تدفقيًا بصفحات من 8 صفوف
  BLOB_PAGE_ROWS: 8,
  JOB_TTL_HOURS: 24,
  /* ===== العرض الصوري (صور ← فيديو 9:16 بتحريك خفيف) ===== */
  SLIDESHOW_MIN_IMAGES: intEnv("SLIDESHOW_MIN_IMAGES", 4),
  SLIDESHOW_MAX_IMAGES: intEnv("SLIDESHOW_MAX_IMAGES", 8),
  SLIDESHOW_IMAGE_MAX_MB: intEnv("SLIDESHOW_IMAGE_MAX_MB", 15),
  // مدة المقطع الواحد (ثوانٍ) و fps — 15 ثانية × 24fps = 360 إطارًا لكل صورة
  SLIDESHOW_CLIP_SEC: intEnv("SLIDESHOW_CLIP_SEC", 15),
  SLIDESHOW_FPS: intEnv("SLIDESHOW_FPS", 24),
  // رأسي 9:16 — 720x1280 افتراضيًا لضمان إتمام كل مقطع داخل مهلة الدالة (60 ثانية على Hobby)
  SLIDESHOW_WIDTH: intEnv("SLIDESHOW_WIDTH", 720),
  SLIDESHOW_HEIGHT: intEnv("SLIDESHOW_HEIGHT", 1280),
  SLIDESHOW_PRESET: process.env.SLIDESHOW_PRESET || "veryfast",
  SLIDESHOW_CRF: intEnv("SLIDESHOW_CRF", 20),
};

const VERSION = "1.1.0";

module.exports = { LIMITS, VERSION, loadEnvFile };
