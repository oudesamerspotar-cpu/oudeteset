/**
 * اختبار وحدات محرك الدمج والتخزين:
 * 1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (640x360 بصوت + 320x240 صامت)
 * 2) دمجهما والتحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت
 * 3) التخزين في Turso والاسترجاع بتطابق sha256
 * 4) مسار رفع الأجزاء (4MB chunks → صفوف 2MB → تجميع → sha256)
 * 5) حدود الحجم (رفض مصدر يتجاوز السقف)
 * 6) الحذف الشامل
 * التشغيل: node scripts/test-unit.js
 */
process.env.MAX_SOURCES = process.env.MAX_SOURCES || "10";
// نستخدم حدًا صغيرًا لاختبار رفض الحجم بسرعة دون تنزيل 200MB
process.env.SOURCE_MAX_MB = "2";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");

const store = require("../lib/db");
const { mergeLocalFiles, downloadUrl, assertSourceCount } = require("../lib/merge");

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

function ffmpegMake(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400)))));
  });
}

async function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** خادم ملفات محلي صغير لاختبار المسار والحدود */
function serveFile(p, port) {
  const data = fs.readFileSync(p);
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Length", String(data.length));
    res.end(data);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(() => new Promise((r) => server.close(r)))));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-unit-"));
  console.log("── توليد فيديوهين مختلفي الدقة بـ ffmpeg ──");

  // فيديو 1: 640x360 4 ثوانٍ مع صوت نغمة
  const clipA = path.join(tmp, "a.mp4");
  await ffmpegMake([
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", clipA,
  ]);

  // فيديو 2: 320x240 3 ثوانٍ صامت تمامًا (اختبار المسار الصامت anullsrc)
  const clipB = path.join(tmp, "b.mp4");
  await ffmpegMake([
    "-f", "lavfi", "-i", "smptebars=size=320x240:rate=25:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", clipB,
  ]);

  console.log("── 1) الدمج المباشر (محرك ffmpeg) ──");
  const outPath = path.join(tmp, "merged.mp4");
  let progressSeen = false;
  const result = await mergeLocalFiles("unittest", [clipA, clipB], outPath, () => {
    progressSeen = true;
  });

  assert("اكتمال الدمج", fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000);
  assert("الدقة = أكبر دقة مدخل (640x360)", result.resolution === "640x360", `الناتج ${result.resolution}`);
  const expectedDur = 7;
  assert(`المدة ≈ مجموع المدد (${expectedDur}ث ±1.2)`, Math.abs(result.duration - expectedDur) <= 1.2, `الناتج ${result.duration.toFixed(2)}ث`);
  assert("التقدم الحي عمل أثناء الترميز", progressSeen);

  // فحص وجود الصوت في الناتج
  const probeRaw = await new Promise((resolve) => {
    const c = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", outPath]);
    let o = "";
    c.stdout.on("data", (d) => (o += d));
    c.on("close", () => resolve(o));
  });
  const streams = JSON.parse(probeRaw).streams || [];
  assert("وجود الصوت في الناتج (المصدر الثاني كان صامتًا → anullsrc)", streams.some((s) => s.codec_type === "audio"));
  assert("الناتج H.264 داخل MP4", streams.some((s) => s.codec_type === "video" && s.codec_name === "h264"));

  console.log("── 2) حدود عدد المصادر ──");
  try {
    assertSourceCount(11);
    assert("رفض أكثر من 10 مصادر", false);
  } catch (e) {
    assert("رفض أكثر من 10 مصادر", /أقصى عدد/.test(e.message));
  }
  try {
    assertSourceCount(0);
    assert("رفض صفر مصادر", false);
  } catch (e) {
    assert("رفض صفر مصادر", /مصدر واحد على الأقل/.test(e.message));
  }

  console.log("── 3) التخزين في Turso والاسترجاع sha256 ──");
  const blob = crypto.randomBytes(5 * 1024 * 1024 + 123_456); // 5.1MB — يشطر لصفوف 2MB
  const jobA = await store.createJob([{ seq: 0, kind: "url", url: "https://example/x.mp4" }]);
  const rows = await store.insertSourceChunk(jobA.id, 0, 0, blob);
  assert(`تقسيم 5.1MB إلى صفوف 2MB (${rows} صفوف)`, rows === 3, `rows=${rows}`);
  const assembled = await store.assembleSource(jobA.id, 0, blob.length, path.join(tmp, "assembled.bin"));
  assert("تجميع الأجزاء من Turso يطابق الأصل sha256", assembled && (await sha256File(path.join(tmp, "assembled.bin"))) === crypto.createHash("sha256").update(blob).digest("hex"));

  const saved = await store.saveOutput(jobA.id, outPath);
  assert(`حفظ الناتج (${saved} صفوف)`, saved > 0);
  const outSize = await store.outputSize(jobA.id);
  assert("حجم الناتج المخزن يطابق الملف", outSize === fs.statSync(outPath).size, `${outSize} ≠ ${fs.statSync(outPath).size}`);

  // قراءة بتدفق Range (وسط الملف)
  const mid = Math.floor(outSize / 2);
  const stream = store.readOutputStream(jobA.id, { start: mid, end: mid + 999 });
  const ranged = [];
  for await (const c of stream) ranged.push(c);
  const rangedBuf = Buffer.concat(ranged);
  const origBuf = fs.readFileSync(outPath);
  assert("قراءة الناتج بمدى Range (وسط الملف) مطابقة", rangedBuf.equals(origBuf.subarray(mid, mid + 1000)));

  console.log("── 4) مسار رفع الأجزاء (chunks 4MB) ──");
  const jobB = await store.createJob([
    { seq: 0, kind: "file", name: "f1.mp4", size: blob.length },
    { seq: 1, kind: "url", url: "https://example/y.mp4" },
  ]);
  const chunkSize = 4 * 1024 * 1024;
  const nChunks = Math.ceil(blob.length / chunkSize);
  for (let k = 0; k < nChunks; k++) {
    await store.insertSourceChunk(jobB.id, 0, k, blob.subarray(k * chunkSize, Math.min((k + 1) * chunkSize, blob.length)));
  }
  const reAssembled = await store.assembleSource(jobB.id, 0, blob.length, path.join(tmp, "reassembled.bin"));
  assert(`رفع ${nChunks} أجزاء ثم التجميع يطابق sha256`, reAssembled && (await sha256File(path.join(tmp, "reassembled.bin"))) === crypto.createHash("sha256").update(blob).digest("hex"));

  console.log("── 5) حدود حجم المصدر أثناء التنزيل ──");
  // ملف 3MB > حد 2MB المعالَج في هذا الاختبار
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(tmp, "big.mp4"), big);
  const stop = await serveFile(path.join(tmp, "big.mp4"), 4990);
  try {
    await downloadUrl("http://127.0.0.1:4990/big.mp4", path.join(tmp, "big-dl.mp4"), 2 * 1024 * 1024);
    assert("رفض مصدر يتجاوز حد الحجم أثناء التنزيل", false);
  } catch (e) {
    assert("رفض مصدر يتجاوز حد الحجم أثناء التنزيل", /حجم/.test(e.message), e.message);
  }
  await stop();

  console.log("── 6) الحذف الشامل ──");
  const deletedA = await store.deleteJobCascade(jobA.id);
  const deletedB = await store.deleteJobCascade(jobB.id);
  const gone = (await store.getJob(jobA.id)) === null && (await store.getJob(jobB.id)) === null;
  assert("الحذف الشامل للمهام والأجزاء", deletedA && deletedB && gone);

  // تنظيف مجلد الاختبار
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}

  console.log(`\n═══ نتيجة اختبار الوحدات: ${pass} ناجح، ${fail} فاشل ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("فشل تشغيل الاختبار:", e);
  process.exit(1);
});
