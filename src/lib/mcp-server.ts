/**
 * بناء خادم MCP الرسمي (Server من @modelcontextprotocol/sdk) مع الأدوات الخمس.
 * مخططات الأدوات مكتوبة JSON يدويًا مطابقةً حرفيًا للمواصفة (enums/defaults/minItems/maxItems)
 * لذلك تتحقق حدود الدمج (≥2 و≤10) برسائل عربية داخل المعالج نفسه.
 * النتائج تُصاغ بالعربية بينما أوصاف الأدوات بالإنجليزية (يقرأها عميل MCP كما هي).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { formatBadModel, formatNoKeys, formatTaskForClient } from "@/lib/format";
import { runGeneration, runMerge, refreshTask, type ProgressNotify } from "@/lib/generation";
import { listRecentTasks } from "@/lib/turso";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

type ExtraLike = {
  signal: AbortSignal;
  sendNotification: (notification: ServerNotification) => Promise<void>;
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/* مخططات الأدوات — مطابقة حرفيًا لقسم 8 من المواصفة */
const TOOL_DEFS = [
  {
    name: "generate_image",
    title: "Generate Image",
    description:
      "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). " +
      "Returns the finished image URL directly if completed within the wait window; otherwise returns a task_id — " +
      "call get_task with that task_id every ~10 seconds until completed, then show the URL and stop.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "What to draw. Detailed prompts give better results." },
        model: { type: "string", enum: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"], default: "gpt-image-2-6/flare-text-to-image" },
        aspect_ratio: { type: "string", enum: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"], default: "auto" },
        resolution: { type: "string", enum: ["1K", "2K", "4K"], default: "1K" },
        background: { type: "string", enum: ["auto", "transparent", "opaque"], default: "auto", description: "Only applied at 1K." },
        output_format: { type: "string", enum: ["png", "jpeg", "webp", "gif"], default: "png" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 240, default: 90 },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_video",
    title: "Generate Video",
    description:
      "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video via image_url). " +
      "Videos take minutes: short wait with live progress streaming, then a task_id — call get_task every ~10 seconds until completed, then show the URL.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", maxLength: 4096, description: "Scene description. Dialogue in the prompt is spoken in the video." },
        image_url: { type: "string", description: "Optional public image URL as the first frame (image-to-video)." },
        model: { type: "string", enum: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"], default: "grok-imagine-video-1-5-preview" },
        aspect_ratio: { type: "string", enum: ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"], default: "auto" },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "480p" },
        enable_audio: { type: "boolean", default: true },
        duration: { type: "integer", minimum: 1, maximum: 15, default: 8, description: "Duration in seconds." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 240, default: 25 },
      },
      required: ["prompt"],
    },
  },
  {
    name: "merge_videos",
    title: "Merge Videos",
    description:
      "Merge multiple clips into ONE final video in the given order. Pass 'urls' (public direct video links — e.g. generate_video results) " +
      "or 'task_ids' (completed video generation tasks — their result URLs are resolved from the database in this order; ideal after generating several clips). " +
      "Merging is usually fast: short wait with live progress, then a merge task_id — track it with get_task. " +
      'Note: "the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly."',
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 10,
          description: "Public direct video URLs (http/https) in merge order — the first clip starts the final video.",
        },
        task_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 10,
          description: "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order.",
        },
        wait_seconds: { type: "integer", minimum: 0, maximum: 240, default: 60 },
      },
    },
  },
  {
    name: "get_task",
    title: "Get Task",
    description:
      "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/merging service while processing). " +
      "Poll every ~10 seconds; when status is completed the result URLs are included — show them to the user and stop polling.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "list_media",
    title: "List Media",
    description:
      "Recall the latest stored images/videos/merges with their result URLs from the database (no regeneration) — useful to retrieve previous results.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["image", "video", "merge"] },
        status: { type: "string", enum: ["completed", "failed", "processing"] },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
] as const;

const KNOWN_TOOLS = TOOL_DEFS.map((t) => t.name).join(", ");

/** إشعارات التقدم الحي — فقط إذا زوّد العميل الطلب بـ _meta.progressToken */
function makeNotify(extra: ExtraLike, progressToken: string | number | undefined): ProgressNotify | undefined {
  if (progressToken === undefined) return undefined;
  return (progress, total, message) => {
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      } as ServerNotification)
      .catch(() => {});
  };
}

/* قراءة معطيات آمنة مع قيم افتراضية */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

async function safeCall(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  // أي عطل داخلي: رسالة عربية نظيفة دون تسريب تفاصيل مفاتيح/رصيد
  try {
    return await fn();
  } catch {
    return text("❌ تعذر إتمام الطلب حاليًا — أعد المحاولة بعد قليل أو تابع بأداة get_task إن كان لديك task_id.", true);
  }
}

export function buildMcpServer(): Server {
  const server = new Server(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = (request.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
    const notify = makeNotify(extra, progressToken);

    switch (name) {
      case "generate_image":
        return safeCall(async () => {
          const prompt = str(args.prompt);
          if (!prompt) return text("❌ الحقل prompt مطلوب ل توليد الصورة — اكتب وصفًا نصيًا.", true);
          const res = await runGeneration(
            "image",
            {
              prompt,
              model: str(args.model),
              aspect_ratio: str(args.aspect_ratio),
              resolution: str(args.resolution),
              background: str(args.background),
              output_format: str(args.output_format),
              wait_seconds: num(args.wait_seconds),
            },
            notify,
            extra.signal,
          );
          if (res.noKeys) return text(formatNoKeys(res.task.model), true);
          if (res.badModel) return text(formatBadModel(res.task.model), true);
          const f = formatTaskForClient(res.task);
          return text(f.text, f.isError);
        });

      case "generate_video":
        return safeCall(async () => {
          const prompt = str(args.prompt);
          if (!prompt) return text("❌ الحقل prompt مطلوب لتوليد الفيديو — اكتب وصف المشهد.", true);
          const res = await runGeneration(
            "video",
            {
              prompt,
              image_url: str(args.image_url),
              model: str(args.model),
              aspect_ratio: str(args.aspect_ratio),
              resolution: str(args.resolution),
              enable_audio: bool(args.enable_audio),
              duration: num(args.duration),
              wait_seconds: num(args.wait_seconds),
            },
            notify,
            extra.signal,
          );
          if (res.noKeys) return text(formatNoKeys(res.task.model), true);
          if (res.badModel) return text(formatBadModel(res.task.model), true);
          const f = formatTaskForClient(res.task);
          return text(f.text, f.isError);
        });

      case "merge_videos":
        return safeCall(async () => {
          const res = await runMerge(
            {
              urls: strArr(args.urls),
              task_ids: strArr(args.task_ids),
              wait_seconds: num(args.wait_seconds),
            },
            notify,
            extra.signal,
          );
          const f = formatTaskForClient(res.task);
          return text(f.text, f.isError);
        });

      case "get_task":
        return safeCall(async () => {
          const taskId = str(args.task_id);
          if (!taskId) return text("❌ الحقل task_id مطلوب — مرر معرف المهمة كما أعادته الأداة.", true);
          const res = await refreshTask(taskId, notify, extra.signal);
          const f = formatTaskForClient(res.task);
          return text(f.text, f.isError);
        });

      case "list_media":
        return safeCall(async () => {
          const tasks = await listRecentTasks(num(args.limit) ?? 10, { type: str(args.type), status: str(args.status) });
          if (tasks.length === 0) {
            return text("لا توجد وسائط مخزنة بعد — قائمة النتائج فارغة. ابدأ بأداة generate_image أو generate_video.");
          }
          const icons: Record<string, string> = { image: "🖼️ صورة", video: "🎬 فيديو", merge: "🔗 دمج" };
          const statusAr: Record<string, string> = { completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "جارية" };
          const lines: string[] = [`📁 أحدث الوسائط المخزنة (${tasks.length}):`];
          tasks.forEach((t, i) => {
            lines.push("", `[${i + 1}] ${icons[t.type] ?? t.type} — ${t.model} — ${statusAr[t.status] ?? t.status}`);
            lines.push(`   task_id: ${t.id}`);
            if (t.prompt) lines.push(`   الوصف: ${t.prompt.slice(0, 120)}`);
            for (const u of t.resultUrls ?? []) lines.push(`   الرابط: ${u}`);
            if (t.status === "failed" && t.errorMessage) lines.push(`   الخطأ: ${t.errorMessage.slice(0, 160)}`);
          });
          return text(lines.join("\n"));
        });

      default:
        return text(`❌ أداة غير معروفة: ${String(name)}. المتاح: ${KNOWN_TOOLS}`, true);
    }
  });

  return server;
}
