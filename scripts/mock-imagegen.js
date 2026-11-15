/**
 * خادم توليد صور وهمي — يحاكي Pollinations بدقة لاختبار مسار prompts دون اعتماد على الشبكة:
 * - GET /prompt/<نص>?width&height&seed → صورة JPEG حقيقية (ffmpeg testsrc2) بمقاس الطلب.
 * - النص يحوي "limitedonce" → أول طلب لهذا الرابط يرد 402 FREE_LIMIT (retry after 2s) ثم ينجح بعدها
 *   (محاكاة استنزاف الحد ثم تعافيه — تختبر منطق الانتظار وإعادة المحاولة).
 * - النص يحوي "limitedforever" → يرد 402 دائمًا (محاكاة خدمة معطلة/حصة لا تنتهي — تختبر رسالة البديل).
 * - النص يحوي "broken" → يرد 500 دائمًا (محاكاة عطل خدمة).
 * - أي نص آخر → 200 صورة.
 * التشغيل: node scripts/mock-imagegen.js (منفذ 4012)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.PORT_MOCK_IMG || 4012);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mock-imggen-"));

/** توليد JPEG اختباري بالمقاس المطلوب (مخزن مؤقتًا لكل مقاس) */
const cache = new Map();
function makeJpeg(width, height, seed) {
  const key = `${width}x${height}:${seed % 4}`;
  if (cache.has(key)) return cache.get(key);
  const p = path.join(TMP, `${key.replace(":", "-")}.jpg`);
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}`, "-frames:v", "1",
    "-vf", `hue=h=${(seed % 4) * 70}`, "-q:v", "4", p,
  ], { stdio: "ignore" });
  const buf = fs.readFileSync(p);
  cache.set(key, buf);
  return buf;
}

const seenOnce = new Set(); // روابط limitedonce التي نجحت بعد أول 402

const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, User-Agent",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const m = /^\/prompt\/(.+)$/.exec(url.pathname);
  const width = Math.min(Number(url.searchParams.get("width")) || 512, 2048);
  const height = Math.min(Number(url.searchParams.get("height")) || 512, 2048);
  const seed = Number(url.searchParams.get("seed")) || 1;
  const prompt = m ? decodeURIComponent(m[1]) : "";

  const freeLimit = (retryAfter) => {
    res.writeHead(402, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: 402, success: false,
      error: { code: "FREE_LIMIT", message: `Free limit reached: 1 image every 45 seconds per IP. Retry after ${retryAfter}s, or get unlimited images with a pollen key at https://enter.pollinations.ai/` },
    }));
  };

  if (prompt.includes("limitedforever")) return freeLimit(2);
  if (prompt.includes("broken")) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("internal error");
  }
  if (prompt.includes("limitedonce")) {
    if (!seenOnce.has(url.pathname + url.search)) {
      seenOnce.add(url.pathname + url.search);
      return freeLimit(2);
    }
  }
  const jpg = makeJpeg(width, height, seed);
  res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(jpg.length) });
  res.end(jpg);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-imagegen] يعمل على http://127.0.0.1:${PORT} — صور الاختبار في ${TMP}`);
});
