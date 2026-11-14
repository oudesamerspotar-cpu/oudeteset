/**
 * اختبار e2e كامل لميزة العرض الصوري على خدمة الدمج المحلية (127.0.0.1:4000):
 * 1) يولّد 6 صور اختبار بأحجام مختلطة (رأسي/أفقي) عبر ffmpeg lavfi.
 * 2) رحلة ملفات: إنشاء مهمة → رفع أجزاء → معالجة كل صورة (مع قياس الزمن) → دمج → تنزيل الناتج وفحصه بـ ffprobe.
 * 3) رحلة روابط: صور محلية عبر خادم HTTP مؤقت → مهمة من روابط → مقطع واحد فقط للتحقق من مسار التنزيل.
 * المطلوب تشغيل مسبق: node scripts/mock-libsql.js + node server.js (في مجلد mini-services/video-merger)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BASE = "http://127.0.0.1:4000";
const TMP = "/tmp/slideshow-e2e";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const N = 6; // رحلة الملفات: 6 صور
const sizes = [
  [800, 1200], // رأسي
  [1200, 800], // أفقي
  [1080, 1920], // رأسي كبير
  [600, 600], // مربع
  [900, 1600], // رأسي
  [1600, 900], // أفقي عريض
];
const imagePaths = [];
for (let i = 0; i < N; i++) {
  const p = path.join(TMP, `img-${i}.jpg`);
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `testsrc2=s=${sizes[i][0]}x${sizes[i][1]}`, "-frames:v", "1", "-q:v", "2", p,
  ], { stdio: "ignore" });
  imagePaths.push(p);
}
console.log(`✅ وُلّدت ${N} صور اختبار في ${TMP}`);

const j = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

/* ===== الرحلة 1: رفع ملفات ===== */
const created = await j(`${BASE}/api/slideshow`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sources: imagePaths.map((p, i) => ({ kind: "file", name: path.basename(p), size: fs.statSync(p).size, mime: "image/jpeg" })),
  }),
});
console.log(`✅ إنشاء المهمة: jobId=${created.jobId} صور=${created.imageCount} مدة المقطع=${created.clipSeconds}ث الإجمالي=${created.totalSeconds}ث`);
if (created.imageCount !== N) throw new Error("عدد الصور غير مطابق");

// رفع الأجزاء (4MB لكل جزء)
for (const up of created.uploads) {
  const buf = fs.readFileSync(imagePaths[up.seq]);
  const chunks = Math.ceil(buf.length / created.uploadChunkBytes);
  for (let k = 0; k < chunks; k++) {
    const part = buf.subarray(k * created.uploadChunkBytes, (k + 1) * created.uploadChunkBytes);
    const url = up.uploadUrl.replace("<k>", String(k));
    const res = await fetch(url, { method: "POST", body: part });
    if (!res.ok) throw new Error(`فشل رفع الجزء ${k} للصورة ${up.seq}: HTTP ${res.status}`);
  }
}
console.log(`✅ رُفعت ${N} صور كاملة`);

// معالجة كل صورة مع قياس الزمن
const clipTimes = [];
for (let seq = 0; seq < N; seq++) {
  const t0 = Date.now();
  const r = await j(`${BASE}/api/slideshow/${created.jobId}/clip?seq=${seq}`, { method: "POST" });
  const dt = (Date.now() - t0) / 1000;
  clipTimes.push(dt);
  console.log(`   مقطع ${seq + 1}/${N}: ${dt.toFixed(1)}ث — حجم=${(r.clipSize / 1024).toFixed(0)}KB جاهز=${r.clipsReady}/${r.totalImages} تقدم=${r.progress}%`);
  if (!r.ok) throw new Error("استجابة clip بلا ok");
}
const total = clipTimes.reduce((a, b) => a + b, 0);
console.log(`✅ كل المقاطع جاهزة — متوسط ${(total / N).toFixed(1)}ث للمقطع (على this sandbox)`);

// دمج
const t0 = Date.now();
const merged = await j(`${BASE}/api/slideshow/${created.jobId}/merge`, { method: "POST" });
console.log(`✅ الدمج: ${((Date.now() - t0) / 1000).toFixed(1)}ث — ${merged.resolution} مدة=${merged.duration.toFixed(1)}ث حجم=${(merged.size / 1024 / 1024).toFixed(2)}MB`);

// تنزيل وفحص
const dl = await fetch(merged.downloadUrl);
if (!dl.ok) throw new Error(`فشل تنزيل الناتج: HTTP ${dl.status}`);
const outPath = path.join(TMP, "final.mp4");
fs.writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", outPath]).toString());
const v = probe.streams.find((s) => s.codec_type === "video");
console.log(`✅ الناتج: ${v.width}x${v.height} @ ${v.r_frame_rate} مدة=${Number(probe.format.duration).toFixed(1)}ث — ${outPath}`);
if (v.width !== 720 || v.height !== 1280) throw new Error(`الدقة ليست 720x1280: ${v.width}x${v.height}`);
const expectDur = N * 15;
if (Math.abs(Number(probe.format.duration) - expectDur) > 3) throw new Error(`المدة ${probe.format.duration} لا تطابق ${expectDur}`);
const codecOk = v.codec_name === "h264";
if (!codecOk) throw new Error("الكودك ليس h264");
console.log("✅ الرحلة 1 (ملفات) ناجحة بالكامل");

/* ===== الرحلة 2: صور بروابط مباشرة ===== */
const staticServer = http.createServer((req, res) => {
  const f = path.join(TMP, path.basename(req.url ?? "/"));
  if (fs.existsSync(f)) {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(fs.readFileSync(f));
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => staticServer.listen(4010, "127.0.0.1", r));
try {
  const urls = imagePaths.slice(0, 4).map((p, i) => `http://127.0.0.1:4010/img-${i}.jpg`);
  const c2 = await j(`${BASE}/api/slideshow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images: urls, clip_seconds: 5 }),
  });
  console.log(`✅ رحلة الروابط: jobId=${c2.jobId} مقاطع ${c2.clipSeconds}ث`);
  for (let seq = 0; seq < 4; seq++) {
    await j(`${BASE}/api/slideshow/${c2.jobId}/clip?seq=${seq}`, { method: "POST" });
  }
  const m2 = await j(`${BASE}/api/slideshow/${c2.jobId}/merge`, { method: "POST" });
  console.log(`✅ رحلة الروابط اكتملت: مدة=${m2.duration.toFixed(1)}ث (المتوقع 20ث) دقة=${m2.resolution}`);
  if (Math.abs(m2.duration - 20) > 2) throw new Error("مدة رحلة الروابط غير صحيحة");
} finally {
  staticServer.close();
}

/* ===== فحوص الرفض ===== */
const rejects = [
  [{ images: imagePaths.slice(0, 3).map((p, i) => `http://127.0.0.1:4010/img-${i}.jpg`) }, 400, "أقل من 4 صور"],
  [{ images: Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.jpg`) }, 400, "أكثر من 8 صور"],
  [{ images: ["ftp://x/y.jpg", "https://a/2.jpg", "https://a/3.jpg", "https://a/4.jpg"] }, 400, "رابط غير http"],
  [{ sources: [{ kind: "file", name: "a.txt", size: 10, mime: "text/plain" }, { kind: "file", name: "b.jpg", size: 10, mime: "image/jpeg" }, { kind: "file", name: "c.jpg", size: 10, mime: "image/jpeg" }, { kind: "file", name: "d.jpg", size: 10, mime: "image/jpeg" }] }, 400, "mime غير صورة"],
  [{ images: ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg", "https://a/4.jpg"], clip_seconds: 3 }, 400, "clip_seconds صغير"],
];
for (const [body, expectStatus, label] of rejects) {
  const res = await fetch(`${BASE}/api/slideshow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== expectStatus) throw new Error(`${label}: توقع ${expectStatus} فكان ${res.status}`);
  console.log(`✅ رفض صحيح (${label}): ${res.status}`);
}

// حماية process.js على مهمة slideshow
const guard = await fetch(`${BASE}/api/jobs/${created.jobId}/process`, { method: "POST" });
if (guard.status !== 400) throw new Error(`حماية process.js: توقعت 400 فكان ${guard.status}`);
console.log("✅ حماية process.js تعمل على مهام العرض الصوري");

// حالة المهمة بعد الاكتمال
const st = await j(`${BASE}/api/slideshow/${created.jobId}`);
if (st.status !== "done" || st.videoUrl === undefined) throw new Error("حالة المهمة النهائية غير سليمة");
console.log("✅ GET /api/slideshow/{id} يرجع الحالة النهائية وروابط الفيديو");

console.log("\n═══ كل اختبارات العرض الصوري ناجحة ═══");
