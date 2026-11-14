/**
 * محرك العرض الصوري — تحويل كل صورة إلى مقطع 15 ثانية رأسي 9:16 بتحريك خفيف (Ken Burns)
 * عبر zoompan في ffmpeg: تقريب تدريجي أو إبعاد أو تحريك جانبي/رأسي، مع وهج دخول/خروج قصير.
 * - الصورة تُكبَّر أولًا إلى 2× المقاس الهدف (تقليل اهتزاز zoompan المعروف) ثم تُقص تغطيةً للإطار.
 * - جميع المقاطع تُرمَّز بإعدادات متطابقة تمامًا (نفس الكودك/الدقة/fps/البكسل) لذا الدمج النهائي
 *   يتم عبر محوّل concat مع -c copy — ثوانٍ معدودة بلا إعادة ترميز.
 * - أنماط التحريك تتناوب على ترتيب الصور (6 أنماط) لمظهر حيوي دون تكرار ممل.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { LIMITS } = require("./env");
const { ffmpegBin, ffprobeBin } = require("./merge");

/** تنفيذ أمر مع جمع stderr وتحليل سطور -progress من stdout */
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
      if (stderr.length > 100_000) stderr = stderr.slice(-60_000);
    });
    child.on("error", (e) => reject(new Error(`فشل تشغيل ${path.basename(bin)}: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else
        reject(
          new Error(
            `خرج ${path.basename(bin)} بالكود ${code}: ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`,
          ),
        );
    });
  });
}

/* ===== التعرف على صيغة الصورة من البايتات الأولى (jpeg/png/gif/webp/bmp) ===== */
function sniffImageType(buffer) {
  const b = buffer.subarray(0, 16);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.toString("ascii", 8, 12) === "WEBP")
    return "webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return null;
}

function assertImageBytes(buffer) {
  const type = sniffImageType(buffer);
  if (!type) {
    throw new Error("الملف ليس صورة مدعومة — الصيغ المقبولة: JPG أو PNG أو WEBP أو GIF أو BMP");
  }
  return type;
}

/* ===== بناء تصفية zoompan حسب نمط التحريك ===== */

/**
 * أنماط التحريك (on = رقم الإطار الناتج من 0 إلى D-1، D = عدد الإطارات):
 * 0) تقريب للداخل متمركزًا 1.00 → 1.18
 * 1) زوم ثابت 1.12 مع تحريك أفقي من اليمين لليسار (اتجاه RTL طبيعي للعين العربية؟ نستخدم يسار→يمين)
 * 2) إبعاد للخارج متمركزًا 1.18 → 1.00
 * 3) زوم ثابت 1.12 مع تحريك رأسي من الأعلى للأسفل
 * 4) تقريب أعمق 1.00 → 1.25
 * 5) زوم ثابت 1.12 مع تحريك أفقي معاكس
 * ملاحظة صياغية: ممنوع الفواصل داخل تعابير zoompan (تُفسَّر كفاصل فلاتر) — لذا لا min/max، حسابات حسابية فقط.
 */
function kenBurnsFilter(variantIndex, { width, height, fps, clipSec }) {
  const W2 = width * 2; // تكبير مسبق لتقليل اهتزاز zoompan
  const H2 = height * 2;
  const D = Math.max(1, Math.round(clipSec * fps));
  const S = `${width}x${height}`;
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  let zp;
  switch (((variantIndex % 6) + 6) % 6) {
    case 0:
      zp = `z='1+0.18*on/${D}':x='${cx}':y='${cy}'`;
      break;
    case 1:
      zp = `z='1.12':x='(iw-iw/zoom)*on/${D}':y='${cy}'`;
      break;
    case 2:
      zp = `z='1.18-0.18*on/${D}':x='${cx}':y='${cy}'`;
      break;
    case 3:
      zp = `z='1.12':x='${cx}':y='(ih-ih/zoom)*on/${D}'`;
      break;
    case 4:
      zp = `z='1+0.25*on/${D}':x='${cx}':y='${cy}'`;
      break;
    default:
      zp = `z='1.12':x='(iw-iw/zoom)*(1-on/${D})':y='${cy}'`;
      break;
  }
  const fadeOutStart = Math.max(0, clipSec - 0.35).toFixed(2);
  return (
    `scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},` +
    `zoompan=${zp}:d=${D}:s=${S}:fps=${fps},` +
    `fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeOutStart}:d=0.35,` +
    `setsar=1,format=yuv420p`
  );
}

/**
 * تحويل صورة واحدة إلى مقطع MP4 رأسي بتحريك خفيف.
 * clipSec: مدة المقطع بالثواني (افتراضي LIMITS.SLIDESHOW_CLIP_SEC).
 * onProgress(pct0to100) للترميز داخل هذا المقطع فقط.
 */
async function makeClip(imagePath, outPath, variantIndex, { clipSec = LIMITS.SLIDESHOW_CLIP_SEC, onProgress } = {}) {
  const { SLIDESHOW_WIDTH: width, SLIDESHOW_HEIGHT: height, SLIDESHOW_FPS: fps, SLIDESHOW_PRESET: preset, SLIDESHOW_CRF: crf } = LIMITS;
  const vf = kenBurnsFilter(variantIndex, { width, height, fps, clipSec });
  const args = [
    "-y",
    "-i", imagePath,
    "-vf", vf,
    "-frames:v", String(Math.round(clipSec * fps)),
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-nostats",
    "-progress", "pipe:1",
    outPath,
  ];
  const totalUs = clipSec * 1_000_000;
  let lastWrite = 0;
  await runCommand(ffmpegBin(), args, {
    onStdoutLine: (line) => {
      if (!line.startsWith("out_time_us=")) return;
      const us = Number(line.split("=")[1]);
      if (!Number.isFinite(us) || !onProgress) return;
      const pct = Math.max(0, Math.min(1, us / totalUs));
      const now = Date.now();
      if (now - lastWrite > 1200) {
        lastWrite = now;
        onProgress(Math.round(pct * 100));
      }
    },
  });
  const st = fs.statSync(outPath);
  if (st.size <= 0) throw new Error("المقطع الناتج فارغ — قد تكون الصورة تالفة");
  return st.size;
}

/** فحص مقطع الناتج: مدة ودقة */
async function probeClip(filePath) {
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
  if (!v) throw new Error("المقطع الناتج بلا مسار فيديو صالح");
  return {
    width: v.width,
    height: v.height,
    duration: Number(v.duration ?? meta.format?.duration ?? 0),
  };
}

/**
 * الدمج النهائي: محوّل concat مع -c copy (المقاطع مُرمَّزة بإعدادات متطابقة) — بلا إعادة ترميز.
 * clipPaths بترتيب العرض النهائي.
 */
async function concatClips(clipPaths, outPath) {
  const listPath = outPath.replace(/\.mp4$/, "-list.txt");
  const lines = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join("\n") + "\n", "utf8");
  try {
    await runCommand(ffmpegBin(), [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-nostats",
      outPath,
    ]);
  } finally {
    try { fs.rmSync(listPath, { force: true }); } catch { /* تجاهل */ }
  }
  const st = fs.statSync(outPath);
  if (st.size <= 0) throw new Error("الفيديو النهائي فارغ");
  if (st.size > LIMITS.OUTPUT_MAX_MB * 1024 * 1024) {
    throw new Error(`حجم الناتج (${(st.size / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد المسموح (${LIMITS.OUTPUT_MAX_MB}MB)`);
  }
  const probe = await probeClip(outPath);
  return { size: st.size, duration: probe.duration, resolution: `${probe.width}x${probe.height}` };
}

module.exports = {
  sniffImageType,
  assertImageBytes,
  kenBurnsFilter,
  makeClip,
  probeClip,
  concatClips,
  runCommand,
};
