/**
 * اختبار e2e كامل لخادم MCP عبر Streamable HTTP (ضد خادم التطوير على 3000):
 * 1) initialize + tools/list + فحص المخططات
 * 2) إضافة مفاتيح بالترتيب: k_bad ثم k_exhausted ثم k_good (ضد مزود kie وهمي على 4600)
 * 3) generate_image بالاسم البديل (2.6) → تكتمل على المفتاح الثالث مع بث تقدم — والعميل لا يرى أي ذكر للمفاتيح/الرصيد
 * 4) فحص حالات المفاتيح بعد التبديل (disabled / exhausted / نشط)
 * 5) get_task → completed
 * 6) generate_video (نافذة قصيرة) → task_id ثم تتبع get_task حتى الرابط
 * 7) merge_videos بـ task_ids لمقطعين عامين → MP4 نهائي على نطاق خدمة الدمج يعمل
 * 8) رفض مقطع واحد وأكثر من 10 برسائل عربية
 * 9) list_media مرتبة من الأحدث
 * 10) get_task بمعرف مجهول → خطأ عربي
 * التشغيل: node scripts/mcp-e2e.mjs (يشغل مزود kie الوهمي بنفسه)
 */
import { spawn } from "node:child_process";

const MCP = "http://127.0.0.1:3000/mcp";
const API = "http://127.0.0.1:3000/api";
let nextId = 1;
let pass = 0;
let fail = 0;
const leakedResponses = [];

function assert(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? " — " + String(detail).slice(0, 300) : ""}`);
  }
}

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
      try {
        messages.push(JSON.parse(t.slice(5).trim()));
      } catch {}
    }
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", messages, text };
}

const call = (method, params) => {
  const id = nextId++;
  return mcpPost({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }).then((r) => ({ ...r, id }));
};
const notify = (method, params) => mcpPost({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });

function singleResult(messages, id) {
  return messages.find((m) => m.id === id && (m.result || m.error));
}

/** استدعاء أداة وإرجاع النص النهائي + إشعارات التقدم */
async function tool(name, args, { progressToken } = {}) {
  const id = nextId++;
  const params = { name, arguments: args };
  if (progressToken) params._meta = { progressToken };
  const { status, contentType, messages } = await mcpPost({ jsonrpc: "2.0", id, method: "tools/call", params });
  const result = messages.find((m) => m.id === id);
  const notifications = messages.filter((m) => !m.id);
  const text = result?.result?.content?.[0]?.text ?? "";
  return { status, contentType, result, notifications, text, isError: Boolean(result?.result?.isError) };
}

async function apiGet(path) {
  const res = await fetch(API + path, { cache: "no-store" });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function apiSend(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const LEAK_RE = /(api\s?key|insufficient|balance|quota|exhausted|unauthorized|مفتاح|رصيد|مستنزف|HTTP 402|HTTP 401|code\":\s*40[12])/i;
function scanLeak(label, text) {
  if (LEAK_RE.test(text)) leakedResponses.push(`${label}: ${text.slice(0, 200)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** تتبع مهمة بـ get_task حتى الاكتمال */
async function pollTask(taskId, maxSeconds = 180, intervalMs = 10_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < maxSeconds * 1000) {
    const { text } = await tool("get_task", { task_id: taskId });
    last = text;
    scanLeak("get_task", text);
    if (text.includes("✅")) return { done: true, text };
    if (text.includes("❌")) return { done: false, text };
    await sleep(intervalMs);
  }
  return { done: false, text: last + " [انتهت مهلة التتبع]" };
}

async function main() {
  // تشغيل المزود الوهمي
  const mock = spawn("node", ["scripts/mock-kie.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
  mock.stdout.on("data", () => {});
  mock.stderr.on("data", (d) => console.error("[mock]", d.toString().slice(0, 200)));

  try {
    await sleep(700);

    console.log("── 0) الجاهزية ──");
    const health = await apiGet("/health");
    assert("الخادم يعمل و Turso متصل", health.status === 200 && health.json.ok === true && health.json.database === "turso-connected");

    // تنظيف مفاتيح اختبار سابقة إن وجدت
    const pre = await apiGet("/keys");
    for (const k of pre.json.keys ?? []) {
      if ((k.label ?? "").startsWith("test-")) await apiSend("DELETE", `/keys/${k.id}`);
    }

    console.log("\n── 1) تهيئة MCP وقائمة الأدوات ──");
    const init = await call("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "1.0" },
    });
    const initResult = singleResult(init.messages, init.id);
    assert("initialize يعيد serverInfo الصحيح", Boolean(initResult?.result?.serverInfo?.name === "media-generator-mcp"), JSON.stringify(initResult?.result?.serverInfo));
    assert("SERVER_INSTRUCTIONS مرفقة مع initialize", typeof initResult?.result?.instructions === "string" && initResult.result.instructions.includes("automatically switches API keys"));
    await notify("notifications/initialized");

    const list = await call("tools/list", {});
    const tools = singleResult(list.messages, list.id)?.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    assert("الأدوات الخمس مسجلة", ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"].every((n) => names.includes(n)), names.join(","));
    void init;

    // فحص المخططات
    const merge = tools.find((t) => t.name === "merge_videos");
    const mergeProps = merge?.inputSchema?.properties ?? {};
    assert("merge_videos بلا resolution/fps وبحد 10", !("resolution" in mergeProps) && !("fps" in mergeProps) && mergeProps.urls?.maxItems === 10 && mergeProps.task_ids?.maxItems === 10);
    const gi = tools.find((t) => t.name === "generate_image");
    const giProps = gi?.inputSchema?.properties ?? {};
    assert("generate_image: نسب الأبعاد والدقة والخلفية كما في المواصفة", giProps.aspect_ratio?.enum?.length === 16 && giProps.resolution?.enum?.join() === "1K,2K,4K" && giProps.background?.enum?.join() === "auto,transparent,opaque");
    assert("generate_image: prompt مطلوب فقط", JSON.stringify(gi?.inputSchema?.required) === '["prompt"]', JSON.stringify(gi?.inputSchema?.required));
    const gv = tools.find((t) => t.name === "generate_video");
    assert("generate_video: duration 1..15 و enable_audio", gv?.inputSchema?.properties?.duration?.maximum === 15 && "enable_audio" in gv.inputSchema.properties);
    const gt = tools.find((t) => t.name === "get_task");
    assert("get_task: task_id مطلوب", JSON.stringify(gt?.inputSchema?.required) === '["task_id"]');
    const lm = tools.find((t) => t.name === "list_media");
    assert("list_media: limit افتراضي 10", lm?.inputSchema?.properties?.limit?.default === 10);

    console.log("\n── 2) إضافة المفاتيح بالترتيب (سيء ← مستنزف ← صحيح) ──");
    const add1 = await apiSend("POST", "/keys", { provider: "kie", api_key: "k_bad_test_01", label: "test-bad" });
    const add2 = await apiSend("POST", "/keys", { provider: "kie", api_key: "k_exhausted_test1", label: "test-exhausted" });
    const add3 = await apiSend("POST", "/keys", { provider: "kie", api_key: "k_good_test_001", label: "test-good" });
    assert("أُضيفت المفاتيح الثلاثة", add1.status === 201 && add2.status === 201 && add3.status === 201);
    const dup = await apiSend("POST", "/keys", { provider: "kie", api_key: "k_good_test_001", label: "test-dup" });
    assert("رفض تكرار مفتاح (409)", dup.status === 409);

    console.log("\n── 3) generate_image (بالاسم البديل 2.6) → تكتمل على المفتاح الثالث ──");
    const img = await tool(
      "generate_image",
      { prompt: "[TEST] cat astronaut floating in space", model: "gpt-image-2.6/flare-text-to-image", wait_seconds: 40 },
      { progressToken: "pt-img" },
    );
    assert("الاستجابة SSE (text/event-stream)", img.contentType.includes("text/event-stream"), img.contentType);
    assert("اكتملت الصورة خلال نافذة الانتظار", img.text.includes("✅ تم توليد الصورة بنجاح"), img.text.slice(0, 200));
    const imgUrl = /https?:\/\/\S+/.exec(img.text)?.[0];
    assert("الرابط المباشر موجود", Boolean(imgUrl), img.text.slice(0, 200));
    assert("وصلت إشعارات تقدم حية (≥2)", img.notifications.filter((n) => n.method === "notifications/progress").length >= 2, `${img.notifications.length} إشعار`);
    assert("شكل الإشعار صحيح (progress/total/message)", img.notifications.some((n) => typeof n.params?.progress === "number" && n.params?.total === 100 && typeof n.params?.message === "string"));
    scanLeak("generate_image", img.text);

    // حالات المفاتيح بعد التبديل
    const keys = (await apiGet("/keys")).json.keys ?? [];
    const byLabel = Object.fromEntries(keys.map((k) => [k.label, k]));
    assert("المفتاح السيء أصبح disabled", byLabel["test-bad"]?.status === "disabled");
    assert("المفتاح المستنزف أصبح exhausted ويبقى في القاعدة", byLabel["test-exhausted"]?.status === "exhausted");
    assert("المفتاح الصحيح نشط ونجح", byLabel["test-good"]?.status === "active" && byLabel["test-good"]?.successCount >= 1);
    assert("المفاتيح مُخفاة في الاستجابة", keys.every((k) => (k.maskedKey ?? "").includes("••••")));
    assert("عدد المحاولات مسجل في المهمة", keys.filter((k) => k.label?.startsWith("test-")).every((k) => k.usageCount >= 1));

    const imgTaskId = /task_id: ([\w-]+)/.exec(img.text)?.[1] ?? "";
    if (img.text.includes("task_id:")) void imgTaskId;

    console.log("\n── 4) صورة بنافذة صفرية → task_id ثم get_task حتى الاكتمال ──");
    const img2 = await tool("generate_image", { prompt: "[TEST] sunset over dunes artwork", wait_seconds: 0 });
    const imageTaskId = extractTaskId(img2.text) ?? "";
    assert("نافذة صفرية تعيد task_id فورًا", Boolean(imageTaskId), img2.text.slice(0, 160));
    if (imageTaskId) {
      const gt = await pollTask(imageTaskId, 60, 5000);
      assert("get_task يتتبع مهمة الصورة حتى الاكتمال مع الرابط", gt.done && gt.text.includes("الرابط المباشر"), gt.text.slice(0, 200));
      const gt2 = await tool("get_task", { task_id: imageTaskId });
      assert("get_task يعيد الروابط نفسها للمكتملة", gt2.text.includes("✅") && gt2.text.includes("الرابط المباشر"), gt2.text.slice(0, 160));
    }

    console.log("\n── 5) generate_video → task_id ثم تتبع حتى الاكتمال ──");
    const vid = await tool("generate_video", { prompt: "[TEST] drone shot over neon city at night", wait_seconds: 4, duration: 8 });
    assert("رد فوري بقيد المعالجة + task_id", vid.text.includes("⏳ المهمة قيد المعالجة") && vid.text.includes("task_id:"), vid.text.slice(0, 200));
    scanLeak("generate_video", vid.text);
    const videoTaskId1 = extractTaskId(vid.text);
    const v1 = await pollTask(videoTaskId1, 90, 6000);
    assert("الفيديو الأول اكتمل عبر get_task", v1.done, v1.text.slice(0, 200));

    const vid2 = await tool("generate_video", { prompt: "[TEST] ocean waves at sunrise", wait_seconds: 4, duration: 6 });
    const videoTaskId2 = extractTaskId(vid2.text);
    const v2 = await pollTask(videoTaskId2, 90, 6000);
    assert("الفيديو الثاني اكتمل", v2.done, v2.text.slice(0, 200));

    console.log("\n── 6) merge_videos بـ task_ids → دمج حقيقي ──");
    const merged = await tool("merge_videos", { task_ids: [videoTaskId1, videoTaskId2], wait_seconds: 180 }, { progressToken: "pt-merge" });
    assert("اكتمل الدمج بنجاح", merged.text.includes("✅ تم دمج المقاطع بنجاح"), merged.text.slice(0, 300));
    assert("تحذير 24 ساعة مذكور حرفيًا", merged.text.includes("⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة"));
    const mergedUrl = /https?:\/\/\S+/.exec(merged.text)?.[0];
    assert("رابط الناتج على نطاق خدمة الدمج", Boolean(mergedUrl && mergedUrl.includes("127.0.0.1:4000")), mergedUrl ?? "لا يوجد رابط");
    scanLeak("merge_videos", merged.text);

    // الناتج يعمل فعليًا
    if (mergedUrl) {
      const head = await fetch(mergedUrl, { headers: { Range: "bytes=0-99" } });
      const buf = await head.arrayBuffer();
      assert("رابط MP4 النهائي يعمل ويتدفق (206)", head.status === 206 && buf.byteLength === 100, `HTTP ${head.status}`);
      // فحص الدقة من حالة مهمة الدمج
      const jobId = /jobs\/([\w-]+)/.exec(mergedUrl)?.[1];
      const job = await (await fetch(`http://127.0.0.1:4000/api/jobs/${jobId}`)).json();
      assert("دقة الدمج = أكبر دقة مدخل (1280x720)", job.resolution === "1280x720", job.resolution);
      assert("الناتج بلا أي نطاق داخلي غير عام", !/^(?!http:\/\/127\.0\.0\.1:4000).*internal/.test(mergedUrl));
    }

    console.log("\n── 7) حدود الدمج ──");
    const one = await tool("merge_videos", { urls: ["https://example.com/a.mp4"], wait_seconds: 1 });
    assert("رفض مقطع واحد برسالة عربية", one.isError && one.text.includes("الدمج يحتاج مقطعَين على الأقل"), one.text.slice(0, 160));
    const eleven = await tool("merge_videos", { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/c${i}.mp4`), wait_seconds: 1 });
    assert("رفض 11 مقطعًا برسالة عربية", eleven.isError && eleven.text.includes("أقصى عدد مقاطع للدمج هو 10"), eleven.text.slice(0, 160));
    const bogusTasks = await tool("merge_videos", { task_ids: ["nonexistent-a", "nonexistent-b"], wait_seconds: 1 });
    assert("task_ids غير صالحة: تفاصيل عربية لكل معرف", bogusTasks.isError && bogusTasks.text.includes("غير موجود"), bogusTasks.text.slice(0, 220));

    console.log("\n── 8) list_media و get_task لمجهول ──");
    const media = await tool("list_media", { limit: 10 });
    assert("list_media يعيد الوسائط المخزنة", media.text.includes("أحدث الوسائط المخزنة") && media.text.includes("الرابط:"), media.text.slice(0, 200));
    const firstEntries = media.text.split("[1]")[1]?.split("[2]")[0] ?? "";
    assert("الترتيب من الأحدث (الدمج أولًا)", firstEntries.includes("دمج") || firstEntries.includes("🔗"), firstEntries.slice(0, 160));
    const unknown = await tool("get_task", { task_id: "bogus-id-123" });
    assert("get_task بمعرف مجهول → خطأ عربي", unknown.isError && unknown.text.includes("لم يتم العثور على مهمة"), unknown.text.slice(0, 160));

    console.log("\n── 9) فحص التسريب ──");
    assert("لا ذكر لمفاتيح أو رصيد في أي رد وصل للعميل", leakedResponses.length === 0, leakedResponses.join(" | "));

    console.log("\n── 10) تنظيف بيانات الاختبار ──");
    // حذف مفاتيح الاختبار
    const keysNow = (await apiGet("/keys")).json.keys ?? [];
    let deletedKeys = 0;
    for (const k of keysNow) if ((k.label ?? "").startsWith("test-")) { await apiSend("DELETE", `/keys/${k.id}`); deletedKeys++; }
    // حذف مهام الاختبار
    const tasks = (await apiGet("/tasks?limit=50")).json.tasks ?? [];
    let deletedTasks = 0;
    const { createClient } = await import("@libsql/client/web");
    const db = createClient({ url: process.env.TURSO_DATABASE_URL ?? (await import("node:fs")).default.readFileSync(".env.local", "utf8").match(/TURSO_DATABASE_URL=(.*)/)[1].trim(), authToken: (await import("node:fs")).default.readFileSync(".env.local", "utf8").match(/TURSO_AUTH_TOKEN=(.*)/)[1].trim() });
    for (const t of tasks) {
      if ((t.prompt ?? "").startsWith("[TEST]")) {
        await db.execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [t.id] });
        deletedTasks++;
      }
    }
    // حذف مهام الدمج من خدمة الدمج
    let deletedJobs = 0;
    if (mergedUrl) {
      const jobId = /jobs\/([\w-]+)/.exec(mergedUrl)?.[1];
      const r = await fetch(`http://127.0.0.1:4000/api/jobs/${jobId}`, { method: "DELETE" });
      if (r.ok) deletedJobs++;
    }
    assert(`التنظيف تم (مفاتيح: ${deletedKeys}، مهام: ${deletedTasks}، مهام دمج: ${deletedJobs})`, deletedKeys >= 3 && deletedTasks >= 3);

    console.log(`\n═══ نتيجة e2e: ${pass} ناجح، ${fail} فاشل ═══`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    mock.kill("SIGTERM");
  }
}

function extractTaskId(text) {
  return /task_id: ([\w-]+)/.exec(text)?.[1] ?? null;
}

main().catch((e) => {
  console.error("فشل تشغيل الاختبار:", e);
  process.exit(1);
});
