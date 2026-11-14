/**
 * اختبار HTTP كامل ضد خادم التطوير المحلي (يحاكي توجيه Vercel):
 * - إنشاء مهمة من روابط → دمج → بث مع Range 206
 * - مهمة مختلطة (رابط + ملف مرفوع بأجزاء) → دمج
 * - حذف → 404 → JSON تالف → قوائم فارغة/مرفوضة
 * التشغيل: node scripts/test-http.js (يشغل الخادم نفسه على منفذ 4300)
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const PORT = 4300;
const CLIP_PORT = 4301;
const BASE = `http://127.0.0.1:${PORT}`;
/* المصادر تُخدم محليًا (خادم ملفات صغير) لاختبار حتمي سريع — روابط عامة تم التحقق منها منفصلًا:
   https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4
   https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4 */
let CLIP_A = ""; // 640x360 بصوت
let CLIP_B = ""; // 320x240 صامت

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

function req(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${BASE}${urlPath}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const jsonOf = (r) => {
  try {
    return JSON.parse(r.buf.toString("utf8"));
  } catch {
    return {};
  }
};

async function waitForServer(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await req("GET", "/api/config");
      if (r.status === 200) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("خادم التطوير لم يجهز في الوقت المحدد");
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** خادم ملفات محلي بسيط لخدمة المقاطع المولدة كروابط مباشرة */
function clipServer(dir, port) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace("/", "");
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const data = fs.readFileSync(p);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(data.length));
    res.end(data);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function ffmpegMake(args) {
  return new Promise((resolve, reject) => {
    const c = spawn("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
  });
}

async function main() {
  // توليد مقطعين محليين مختلفي الدقة (الأول بصوت والثاني صامت)
  const clipsDir = fs.mkdtempSync(path.join(os.tmpdir(), "merger-clips-"));
  const aPath = path.join(clipsDir, "clip_a_640x360.mp4");
  const bPath = path.join(clipsDir, "clip_b_320x240.mp4");
  await ffmpegMake(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", aPath]);
  await ffmpegMake(["-f", "lavfi", "-i", "smptebars=size=320x240:rate=25:duration=2", "-c:v", "libx264", "-preset", "veryfast", bPath]);
  CLIP_A = `http://127.0.0.1:${CLIP_PORT}/clip_a_640x360.mp4`;
  CLIP_B = `http://127.0.0.1:${CLIP_PORT}/clip_b_320x240.mp4`;

  // تشغيل خادم التطوير
  const server = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (d) => (serverErr += d));
  let clipSrv = null;

  try {
    clipSrv = await clipServer(clipsDir, CLIP_PORT);
    await waitForServer();
    console.log("── الخادم جاهز على", BASE, "──\n");

    console.log("── 1) config ──");
    const cfg = await req("GET", "/api/config");
    const cfgJ = jsonOf(cfg);
    assert("GET /api/config يعمل", cfg.status === 200 && cfgJ.ok === true);
    assert("الحدود موجودة في config (maxSources=10)", cfgJ.limits?.maxSources === 10);

    console.log("\n── 2) مهمة من روابط (640x360 + 1280x720) ──");
    const create = await req("POST", "/api/jobs", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: [CLIP_A, CLIP_B] }),
    });
    const createJ = jsonOf(create);
    assert("POST /api/jobs → 201", create.status === 201, JSON.stringify(createJ).slice(0, 160));
    assert("استجابة الإنشاء تحمل statusUrl و processUrl و expiresAt", Boolean(createJ.jobId && createJ.statusUrl && createJ.processUrl && createJ.expiresAt));
    const jobId = createJ.jobId;

    // أكثر من 10 مقاطع → رفض
    const tooMany = await req("POST", "/api/jobs", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: Array.from({ length: 11 }, () => CLIP_A) }),
    });
    assert("رفض 11 مقطعًا", tooMany.status === 400 && /أقصى عدد/.test(jsonOf(tooMany).error ?? ""));

    // مهمة مختلطة: رابط + ملف مرفوع (نولّده محليًا عبر ffmpeg)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
    const clipPath = path.join(tmp, "small.mp4");
    await new Promise((resolve, reject) => {
      const c = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-c:v", "libx264", "-preset", "veryfast", clipPath]);
      c.on("close", (code) => (code === 0 ? resolve() : reject(new Error("فشل توليد المقطع المحلي"))));
    });
    const clipBuf = fs.readFileSync(clipPath);

    const mixed = await req("POST", "/api/jobs", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: [{ kind: "file", name: "small.mp4", size: clipBuf.length }, { kind: "url", url: CLIP_A }] }),
    });
    const mixedJ = jsonOf(mixed);
    assert("إنشاء مهمة مختلطة (رابط + ملف)", mixed.status === 201 && Array.isArray(mixedJ.uploads) && mixedJ.uploads.length === 1);
    assert("الاستجابة تحمل uploadChunkBytes", mixedJ.uploadChunkBytes === 4 * 1024 * 1024);
    const mixedId = mixedJ.jobId;

    // رفع الملف بأجزاء 4MB (ملفنا صغير → جزء واحد)
    const chunkCount = Math.ceil(clipBuf.length / mixedJ.uploadChunkBytes);
    let uploadedAll = true;
    for (let k = 0; k < chunkCount; k++) {
      const part = clipBuf.subarray(k * mixedJ.uploadChunkBytes, Math.min((k + 1) * mixedJ.uploadChunkBytes, clipBuf.length));
      const up = await req("POST", `/api/upload?job=${mixedId}&seq=0&chunk=${k}`, { body: part, headers: { "Content-Type": "application/octet-stream" } });
      if (up.status !== 200) uploadedAll = false;
    }
    assert(`رفع ملف بأجزاء (${chunkCount} جزء)`, uploadedAll);

    // جزء بمعطيات ناقصة → 400
    const badUp = await req("POST", "/api/upload", { body: Buffer.from("x"), headers: { "Content-Type": "application/octet-stream" } });
    assert("رفع بلا معطيات → 400", badUp.status === 400);

    console.log("\n── 3) تنفيذ الدمج ──");
    const proc = await req("POST", `/api/jobs/${jobId}/process`);
    const procJ = jsonOf(proc);
    assert("POST process → 200 done", proc.status === 200 && procJ.status === "done", JSON.stringify(procJ).slice(0, 200));
    assert("النتيجة تحمل videoUrl و downloadUrl و resolution", Boolean(procJ.videoUrl && procJ.downloadUrl && procJ.resolution));
    assert(`الدقة = أكبر دقة مدخل (640x360)`, procJ.resolution === "640x360", `الناتج ${procJ.resolution}`);
    assert(`المدة ≈ 5 ثوانٍ`, Math.abs((procJ.duration ?? 0) - 5) <= 1.5, `الناتج ${procJ.duration}ث`);
    const videoUrl = procJ.videoUrl;
    const videoPath = "/" + videoUrl.split(BASE + "/")[1];

    // مهمة مختلطة
    const proc2 = await req("POST", `/api/jobs/${mixedId}/process`);
    assert("دمج المهمة المختلطة → done", proc2.status === 200 && jsonOf(proc2).status === "done");

    console.log("\n── 4) البث و Range ──");
    const full = await req("GET", videoPath);
    assert("بث كامل → 200 مع Content-Length صحيح", full.status === 200 && Number(full.headers["content-length"]) === full.buf.length && full.headers["accept-ranges"] === "bytes");
    assert("نوع المحتوى video/mp4", String(full.headers["content-type"]).includes("video/mp4"));

    const ranged = await req("GET", videoPath, { headers: { Range: "bytes=0-999" } });
    assert("Range bytes=0-999 → 206 مع Content-Range", ranged.status === 206 && ranged.buf.length === 1000 && String(ranged.headers["content-range"]).startsWith("bytes 0-999/"), `status=${ranged.status} len=${ranged.buf.length} cr=${ranged.headers["content-range"]}`);

    const ranged2 = await req("GET", videoPath, { headers: { Range: `bytes=${Math.floor(full.buf.length / 2)}-` } });
    assert(
      "Range مفتوح النهاية → 206 بطول النصف المتبقي",
      ranged2.status === 206 && ranged2.buf.length === full.buf.length - Math.floor(full.buf.length / 2),
      `status=${ranged2.status} len=${ranged2.buf.length} total=${full.buf.length} cr=${ranged2.headers["content-range"]}`,
    );

    const dl = await req("GET", videoPath + "?download=1");
    assert("?download=1 يعطي Content-Disposition", String(dl.headers["content-disposition"] ?? "").includes("attachment"));

    // بث المهمة المختلطة
    const proc2J = jsonOf(proc2);
    const mixedVideo = await req("GET", "/" + proc2J.videoUrl.split(BASE + "/")[1], { headers: { Range: "bytes=0-499" } });
    assert("بث المهمة المختلطة مع Range → 206", mixedVideo.status === 206 && mixedVideo.buf.length === 500);

    console.log("\n── 5) الحذف و404 وJSON تالف ──");
    const del = await req("DELETE", `/api/jobs/${mixedId}`);
    assert("DELETE → ok", del.status === 200 && jsonOf(del).ok === true);
    const afterDel = await req("GET", `/api/jobs/${mixedId}`);
    assert("GET بعد الحذف → 404", afterDel.status === 404);
    const afterDelVideo = await req("GET", "/" + proc2J.videoUrl.split(BASE + "/")[1]);
    assert("بث الناتج بعد الحذف → 404", afterDelVideo.status === 404);
    const delAgain = await req("DELETE", `/api/jobs/${mixedId}`);
    assert("DELETE مرة أخرى → 404", delAgain.status === 404);
    const missing = await req("GET", "/api/jobs/nonexistent123");
    assert("GET مهمة غير موجودة → 404", missing.status === 404);
    const badJson = await req("POST", "/api/jobs", { headers: { "Content-Type": "application/json" }, body: Buffer.from("{سالم") });
    assert("JSON تالف → 400 مع رسالة عربية", badJson.status === 400 && /JSON/.test(jsonOf(badJson).error ?? ""));
    const emptyList = await req("POST", "/api/jobs", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [] }) });
    assert("قائمة فارغة → 400", emptyList.status === 400);
    const wrongMethod = await req("PUT", "/api/jobs");
    assert("طريقة خاطئة → 405", wrongMethod.status === 405);

    // تنظيف مهمة الدمج الأولى
    await req("DELETE", `/api/jobs/${jobId}`);

    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  } finally {
    server.kill("SIGTERM");
    if (clipSrv) clipSrv.close();
    try {
      fs.rmSync(clipsDir, { recursive: true, force: true });
    } catch {}
    if (fail > 0 && serverErr) console.log("\n[server stderr]", serverErr.slice(-800));
  }

  console.log(`\n═══ نتيجة اختبار HTTP: ${pass} ناجح، ${fail} فاشل ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("فشل تشغيل الاختبار:", e);
  process.exit(1);
});
