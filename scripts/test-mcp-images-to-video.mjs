/**
 * اختبار e2e لأداة MCP الجديدة images_to_video عبر /mcp (ضد خادم التطوير على 3000):
 * 1) tools/list تتضمن images_to_video بمخططها الصحيح
 * 2) رحلة كاملة: 6 صور روابط محلية → اكتمال داخل نافذة الانتظار → رابط فيديو + رابط تنزيل
 * 3) get_task على المهمة → completed مع الروابط
 * 4) list_media?type=slideshow تعرضها
 * 5) رفض: 3 صور / 9 صور / روابط غير مباشرة — رسائل عربية
 * المتطلبات: node scripts/mock-libsql.js + خدمة الدمج على 4000 + next dev على 3000
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MCP = "http://127.0.0.1:3000/mcp";
const API = "http://127.0.0.1:3000/api";
let nextId = 1;
let pass = 0;
let fail = 0;
const assert = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? " — " + String(detail).slice(0, 400) : ""}`);
  }
};

const ACCEPT = "application/json, text/event-stream";
async function mcpPost(payload) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const messages = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("data:")) {
      try { messages.push(JSON.parse(t.slice(5).trim())); } catch {}
    }
  }
  return { status: res.status, messages, text };
}
const call = (method, params) => {
  const id = nextId++;
  return mcpPost({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }).then((r) => ({ ...r, id }));
};
function singleResult(messages, id) {
  const msg = messages.find((m) => m.id === id);
  if (!msg || !msg.result) return null;
  return (msg.result.content ?? []).find((c) => c.type === "text")?.text ?? null;
}

/* صور اختبار محلية يخدمها خادم HTTP صغير */
const TMP = "/tmp/mcp-slideshow-test";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const N = 6;
for (let i = 0; i < N; i++) {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `testsrc2=s=${800 + i * 100}x${1400 - i * 50}`, "-frames:v", "1", "-q:v", "3",
    path.join(TMP, `p${i}.jpg`),
  ], { stdio: "ignore" });
}
const staticServer = http.createServer((req, res) => {
  const f = path.join(TMP, path.basename(req.url ?? "/"));
  if (fs.existsSync(f)) {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(fs.readFileSync(f));
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => staticServer.listen(4011, "127.0.0.1", r));
const urls = Array.from({ length: N }, (_, i) => `http://127.0.0.1:4011/p${i}.jpg`);

try {
  /* 1) tools/list */
  const init = await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "slideshow-e2e", version: "1.0.0" },
  });
  assert("initialize يعمل", init.status === 200 && init.messages.some((m) => m.id === init.id && m.result), init.text?.slice(0, 200));
  const list = await call("tools/list", {});
  const tools = list.messages.find((m) => m.id === list.id)?.result?.tools ?? [];
  const itv = tools.find((t) => t.name === "images_to_video");
  assert("tools/list يتضمن images_to_video", Boolean(itv));
  const schema = itv?.inputSchema ?? {};
  assert("minImages/maxImages = 4/8 في المخطط", schema.properties?.images?.minItems === 4 && schema.properties?.images?.maxItems === 8);
  assert("clip_seconds 5..20 في المخطط", schema.properties?.clip_seconds?.minimum === 5 && schema.properties?.clip_seconds?.maximum === 20);

  /* 2) رحلة كاملة بالروابط */
  console.log("  ⏳ تشغيل images_to_video على 6 صور (قد يستغرق ~30 ثانية)…");
  const t0 = Date.now();
  const run = await call("tools/call", {
    name: "images_to_video",
    arguments: { images: urls, wait_seconds: 200 },
  });
  const runText = singleResult(run.messages, run.id) ?? "";
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ⏱ اكتمل في ${elapsed}ث`);
  assert("النتيجة نجاح عربي (تم إنشاء الفيديو)", runText.includes("✅"), runText.slice(0, 200));
  assert("يذكر الرأسي 9:16", runText.includes("9:16"));
  const videoUrl = runText.split("\n").find((l) => l.startsWith("الرابط المباشر:"))?.replace("الرابط المباشر:", "").trim();
  assert("يحتوي رابط فيديو مباشر", Boolean(videoUrl && videoUrl.startsWith("http")), videoUrl);
  assert("تحذير 24 ساعة موجود", runText.includes("24 ساعة"));
  if (videoUrl) {
    const dl = await fetch(`${videoUrl}?download=1`);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert("الفيديو النهائي قابل للتنزيل (MP4 حجم > 1MB)", dl.ok && buf.length > 1024 * 1024, `حجم=${buf.length}`);
    fs.writeFileSync(path.join(TMP, "final.mp4"), buf);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path.join(TMP, "final.mp4")]).toString());
    const v = probe.streams.find((s) => s.codec_type === "video");
    assert("أبعاد الناتج رأسية 720x1280", v?.width === 720 && v?.height === 1280, `${v?.width}x${v?.height}`);
    assert("مدة الناتج 90 ثانية (6×15)", Math.abs(Number(probe.format?.duration) - 90) < 3, probe.format?.duration);
  }

  /* 3) get_task على المهمة */
  const tasksRes = await fetch(`${API}/tasks?limit=5`, { cache: "no-store" });
  const tasksData = await tasksRes.json();
  const slideTask = tasksData.tasks.find((t) => t.type === "slideshow");
  assert("مهمة slideshow مسجلة في قاعدة البيانات", Boolean(slideTask), JSON.stringify(tasksData.tasks.slice(0, 2)));
  assert("نموذج المهمة images-to-video", slideTask?.model === "images-to-video", slideTask?.model);
  assert("حالة المهمة مكتملة", slideTask?.status === "completed", slideTask?.status);
  if (slideTask) {
    const gt = await call("tools/call", { name: "get_task", arguments: { task_id: slideTask.id } });
    const gtText = singleResult(gt.messages, gt.id) ?? "";
    assert("get_task تعيد الروابط", gtText.includes("الرابط المباشر"), gtText.slice(0, 150));
  }

  /* 4) list_media بالفلتر */
  const lm = await call("tools/call", { name: "list_media", arguments: { type: "slideshow", limit: 5 } });
  const lmText = singleResult(lm.messages, lm.id) ?? "";
  assert("list_media(type=slideshow) تعرض المهمة", lmText.includes("عرض صوري") && lmText.includes("images-to-video"), lmText.slice(0, 200));

  /* 5) الرفض */
  const few = await call("tools/call", { name: "images_to_video", arguments: { images: urls.slice(0, 3) } });
  const fewText = singleResult(few.messages, few.id) ?? "";
  assert("رفض 3 صور برسالة عربية", fewText.includes("4 صور على الأقل"), fewText.slice(0, 150));
  const many = await call("tools/call", { name: "images_to_video", arguments: { images: Array.from({ length: 9 }, (_, i) => `https://x/${i}.jpg`) } });
  const manyText = singleResult(many.messages, many.id) ?? "";
  assert("رفض 9 صور برسالة عربية", manyText.includes("8"), manyText.slice(0, 150));
  const bad = await call("tools/call", { name: "images_to_video", arguments: { images: ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg", "notaurl"] } });
  const badText = singleResult(bad.messages, bad.id) ?? "";
  assert("رفض رابط غير مباشر برسالة عربية", badText.includes("روابط مباشرة"), badText.slice(0, 150));
} finally {
  staticServer.close();
}

console.log(`\n═══ نتيجة اختبار أداة images_to_video: ${pass} ناجح، ${fail} فاشل ═══`);
process.exit(fail > 0 ? 1 : 0);
