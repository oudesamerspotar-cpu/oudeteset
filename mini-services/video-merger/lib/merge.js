/**
 * محرك الدمج (الأهم) — جودة عالية إلزامية:
 * - ffprobe لكل مصدر: الدقة، المدة، وجود صوت.
 * - توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة بين المدخلات
 *   (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p ثم concat.
 * - مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج.
 * - الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart → MP4 عالي الجودة.
 * - التقدم: قراءة out_time_us من -progress pipe:1 وخزن النسبة (0-40 سحب، 40-90 ترميز، 100 اكتمال).
 * - التحقق من الحدود قبل وأثناء العمل — تجاوز أي حد = فشل واضح برسالة وليس انهيارًا.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { LIMITS } = require("./env");

/* ===== إيجاد ثنائيات ffmpeg/ffprobe ===== */

/** ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة: ننسخه إلى /tmp بصلاحية 755 عند الحاجة */
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `merger-bin-${path.basename(binPath)}`);
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function resolveBinary(name) {
  // نفضّل الحزم المثبتة (مطلوبة على Vercel) ونسقط إلى ثنائيات النظام في التطوير المحلي
  try {
    if (name === "ffmpeg") {
      const p = require("ffmpeg-static");
      if (p) return ensureExecutable(p);
    } else {
      const m = require("ffprobe-static");
      const p = m && m.path;
      if (p) return ensureExecutable(p);
    }
  } catch {
    /* غير مثبتة محليًا */
  }
  return name; // اعتماد PATH
}

const ffmpegBin = () => resolveBinary("ffmpeg");
const ffprobeBin = () => resolveBinary("ffprobe");

/* ===== أدوات مساندة ===== */

/** تنفيذ أمر مع جمع stdout/stderr وتحليل الحدود */
function runCommand(bin, args, { onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdoutBuf += d;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (onStdoutLine && line) onStdoutLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (e) => reject(new Error(`فشل تشغيل ${path.basename(bin)}: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`خرج ${path.basename(bin)} بالكود ${code}: ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`));
    });
  });
}

async function probeFile(filePath) {
  // ffprobe يطبع JSON على stdout مباشرة
  const raw = await new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin(), ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath]);
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => reject(e));
    child.on("close", () => resolve(out));
  });
  const meta = JSON.parse(raw);
  const v = (meta.streams || []).find((s) => s.codec_type === "video");
  const a = (meta.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو صالحًا");
  return {
    width: v.width,
    height: v.height,
    fps: Number(v.r_frame_rate ? evalFps(v.r_frame_rate) : 30) || 30,
    duration: Number(v.duration ?? meta.format?.duration ?? 0),
    hasAudio: Boolean(a),
  };
}

function evalFps(r) {
  const [n, d] = String(r).split("/").map(Number);
  if (!Number.isFinite(n)) return 30;
  return d ? n / d : n;
}

/** تنزيل رابط مباشر إلى /tmp مع عدّ بايتات وفرض حد الحجم أثناء التنزيل */
async function downloadUrl(url, destPath, maxBytes) {
  if (!/^https?:\/\//.test(url)) throw new Error("روابط الفيديو يجب أن تكون http/https مباشرة");
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new Error(`تعذر تنزيل المصدر (${url.slice(0, 80)}…): ${e.message}`);
  }
  if (!res.ok || !res.body) throw new Error(`تعذر تنزيل المصدر (${url.slice(0, 80)}…): HTTP ${res.status}`);
  const fs2 = require("node:fs");
  const out = fs2.createWriteStream(destPath);
  let bytes = 0;
  let failMessage = null;
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on("data", (c) => {
    bytes += c.length;
    if (bytes > maxBytes && !failMessage) {
      failMessage = `حجم المصدر يتجاوز الحد المسموح (${LIMITS.SOURCE_MAX_MB}MB لكل رابط مصدر)`;
      nodeStream.destroy();
      out.destroy(failMessage);
    }
  });
  await new Promise((resolve, reject) => {
    nodeStream.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", (e) => reject(new Error(failMessage || e.message)));
    nodeStream.on("error", (e) => reject(new Error(failMessage || e.message)));
  });
  return bytes;
}

/** حساب الدقة الهدف: أكبر دقة بين المدخلات مع سقف 1920×1080 وأبعاد زوجية */
function targetDimensions(probes) {
  const maxW = Math.max(...probes.map((p) => p.width));
  const maxH = Math.max(...probes.map((p) => p.height));
  const cap = Math.min(1920 / maxW, 1080 / maxH, 1);
  const even = (n) => Math.max(2, Math.floor((n * cap) / 2) * 2);
  return { width: even(maxW), height: even(maxH) };
}

/** بناء filter_complex الكامل مع مسارات صامتة للمصادر بلا صوت */
function buildFilterArgs(probes, target) {
  const { width, height } = target;
  const filters = [];
  const silentInputs = [];
  let silentCount = 0;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`,
    );
    if (p.hasAudio) {
      filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // مدخل lavfi صامت بنفس مدة هذا المصدر — يضاف بعد مدخلات الفيديو
      const lavfiIdx = probes.length + silentCount;
      silentCount++;
      silentInputs.push("-f", "lavfi", "-t", String(Math.max(0.1, p.duration).toFixed(3)), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      filters.push(`[${lavfiIdx}:a]atrim=0:${Math.max(0.1, p.duration).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    }
  }
  const concatPairs = probes.map((_, i) => `[v${i}][a${i}]`).join("");
  filters.push(`${concatPairs}concat=n=${probes.length}:v=1:a=1[vout][aout]`);
  return { silentInputs, filterComplex: filters.join(";"), mapArgs: ["-map", "[vout]", "-map", "[aout]"] };
}

/** إدارة تنظيف /tmp في finally */
function withTmpDir(jobId, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${jobId}-`));
  return Promise.resolve(fn(dir)).finally(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* تجاهل */
    }
  });
}

/**
 * دمج ملفات محلية (مسارات /tmp جاهزة) — الوحدة الأساسية التي تستخدمها نقطة process.
 * onProgress(pct0to100) تُستدعى أثناء الترميز.
 */
async function mergeLocalFiles(jobId, filePaths, outPath, onProgress) {
  // 1) فحص كل مصدر
  const probes = [];
  for (const p of filePaths) {
    probes.push(await probeFile(p));
  }
  const totalDuration = probes.reduce((s, p) => s + (Number.isFinite(p.duration) ? p.duration : 0), 0);
  if (totalDuration > LIMITS.MAX_TOTAL_DURATION_SEC) {
    throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)}ث) يتجاوز الحد المسموح (${LIMITS.MAX_TOTAL_DURATION_SEC} ثانية)`);
  }

  // 2) بناء التصفية
  const target = targetDimensions(probes);
  const { silentInputs, filterComplex, mapArgs } = buildFilterArgs(probes, target);

  const args = ["-y"];
  for (const p of filePaths) args.push("-i", p);
  args.push(...silentInputs);
  args.push("-filter_complex", filterComplex, ...mapArgs);
  args.push(
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", LIMITS.FFMPEG_PRESET,
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-nostats",
    "-progress", "pipe:1",
    outPath,
  );

  // 3) ترميز مع تقدم حي (40 → 90)
  const totalUs = totalDuration * 1_000_000;
  let lastWrite = 0;
  await runCommand(ffmpegBin(), args, {
    onStdoutLine: (line) => {
      if (!line.startsWith("out_time_us=")) return;
      const us = Number(line.split("=")[1]);
      if (!Number.isFinite(us) || totalUs <= 0) return;
      const pct = Math.max(0, Math.min(1, us / totalUs));
      const dbProgress = 40 + Math.round(pct * 50);
      const now = Date.now();
      if (onProgress && now - lastWrite > 1200) {
        lastWrite = now;
        onProgress(dbProgress);
      }
    },
  });

  // 4) فحص الناتج
  const st = fs.statSync(outPath);
  if (st.size > LIMITS.OUTPUT_MAX_MB * 1024 * 1024) {
    throw new Error(`حجم الناتج (${(st.size / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد المسموح (${LIMITS.OUTPUT_MAX_MB}MB)`);
  }
  const outProbe = await probeFile(outPath);
  return {
    size: st.size,
    duration: outProbe.duration,
    resolution: `${outProbe.width}x${outProbe.height}`,
  };
}

/** فحص حدود المصادر قبل العمل (العدد) */
function assertSourceCount(n) {
  if (n < 1) throw new Error("يلزم مصدر واحد على الأقل لتنفيذ الدمج");
  if (n > LIMITS.MAX_SOURCES) throw new Error(`أقصى عدد مقاطع للدمج هو ${LIMITS.MAX_SOURCES}`);
}

module.exports = {
  ffmpegBin,
  ffprobeBin,
  ensureExecutable,
  probeFile,
  downloadUrl,
  targetDimensions,
  buildFilterArgs,
  mergeLocalFiles,
  assertSourceCount,
  withTmpDir,
};
