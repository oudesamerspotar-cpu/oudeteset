/**
 * مزود kie.ai وهمي لاختبارات e2e — يحاكي Jobs API الموحد بأشكال الاستجابة الحقيقية:
 * POST /api/v1/jobs/createTask
 *   k_bad        → 401 {"code":401,"msg":"invalid api key"}            (مفتاح مرفوض → disabled)
 *   k_exhausted  → 402 {"code":402,"msg":"insufficient balance"}        (رصيد → exhausted)
 *   k_good       → 200 {"code":200,"data":{"taskId":"mock-N"}}
 * GET  /api/v1/jobs/recordInfo?taskId=
 *   حالة generating مع progress تصاعدي ثم success بعد التأخير، و resultJson نصّ JSON داخل JSON
 *   (نفس شكل kie الحقيقي: {"state":"success","resultJson":"{\"resultUrls\":[\"...\"]}"})
 * التشغيل: node scripts/mock-kie.mjs  (منفذ 4600)
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_KIE_PORT || 4600);
const IMAGE_DELAY_MS = Number(process.env.MOCK_IMAGE_DELAY_MS || 7000);
const VIDEO_DELAY_MS = Number(process.env.MOCK_VIDEO_DELAY_MS || 10000);
// روابط النتائج الوهمية — صور عامة وفيديوهان عامان بدقتين مختلفتين (من أمثلة المواصفة)
const IMAGE_URL = process.env.MOCK_IMAGE_URL || "https://www.gstatic.com/webp/gallery/1.png";
const VIDEO_URLS = (process.env.MOCK_VIDEO_URLS ||
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4|https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4"
).split("|");

const tasks = new Map(); // taskId → { createdAt, kind, url }
let counter = 0;
let videoCounter = 0;

const body = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/v1/jobs/createTask" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const auth = String(req.headers.authorization || "");
      const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      console.log(`[mock] createTask key=${key.slice(0, 12)}`);
      if (key === "k_bad_test_01") return body(res, 401, { code: 401, msg: "invalid api key" });
      if (key === "k_exhausted_test1") return body(res, 402, { code: 402, msg: "insufficient balance" });

      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        return body(res, 400, { code: 400, msg: "bad request body" });
      }
      const model = String(payload.model ?? "");
      const input = payload.input ?? {};
      if (!model) return body(res, 400, { code: 400, msg: "model is required" });
      if (!input.prompt) return body(res, 400, { code: 400, msg: "prompt is required" });
      if (key !== "k_good_test_001") return body(res, 401, { code: 401, msg: "unauthorized" });

      const isVideo = model.includes("video");
      const taskId = `mock-${isVideo ? "v" : "i"}-${++counter}`;
      tasks.set(taskId, {
        createdAt: Date.now(),
        kind: isVideo ? "video" : "image",
        url: isVideo ? VIDEO_URLS[videoCounter++ % VIDEO_URLS.length] : IMAGE_URL,
      });
      body(res, 200, { code: 200, data: { taskId } });
    });
    return;
  }

  if (url.pathname === "/api/v1/jobs/recordInfo" && req.method === "GET") {
    const taskId = url.searchParams.get("taskId") ?? "";
    const t = tasks.get(taskId);
    if (!t) {
      console.log(`[mock] recordInfo ${taskId}: غير موجود`);
      return body(res, 200, { code: 200, data: { state: "fail", failMsg: "task not found" } });
    }
    const delay = t.kind === "video" ? VIDEO_DELAY_MS : IMAGE_DELAY_MS;
    const elapsed = Date.now() - t.createdAt;
    if (elapsed >= delay) {
      // resultJson نصّ JSON داخل JSON — مطابق لشكل kie الحقيقي
      return body(res, 200, {
        code: 200,
        data: { state: "success", resultJson: JSON.stringify({ resultUrls: [t.url] }) },
      });
    }
    const progress = Math.min(95, Math.round((elapsed / delay) * 95));
    if (Math.floor(elapsed / 3000) !== Math.floor((elapsed - 100) / 3000)) console.log(`[mock] recordInfo ${taskId}: ${elapsed}ms progress=${progress}`);
    return body(res, 200, { code: 200, data: { state: elapsed > 1500 ? "generating" : "queuing", progress } });
  }

  body(res, 404, { code: 404, msg: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`مزود kie الوهمي يعمل على http://127.0.0.1:${PORT}`);
});
