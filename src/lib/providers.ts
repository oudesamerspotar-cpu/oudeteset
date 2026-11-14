/**
 * مزوّدو التوليد — واجهة موحّدة فوق kie.ai (Jobs API) و CometAPI.
 * أي خطأ يُرمى بـ ProviderError { status, message } ليُصنَّف في classifyProviderError.
 * القاعدة الذهبية: لا ننزّل أي ملف وسائط — نتعامل مع الروابط فقط.
 */
import { ProviderError } from "@/lib/errors";
import type { ProviderId } from "@/lib/models";

export interface ProviderInput {
  prompt: string;
  imageUrl?: string; // image-to-video اختياري
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
}

export interface TaskCheck {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId */
  createTask(apiKey: string, providerModel: string, input: ProviderInput, type: "image" | "video"): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(apiKey: string, providerModel: string, input: ProviderInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(apiKey: string, providerTaskId: string): Promise<TaskCheck>;
}

const KIE_BASE = process.env.KIE_API_BASE || "https://api.kie.ai";

/**
 * kie.ai — Jobs API الموحد.
 * createTask → {"code":200,"data":{"taskId":"..."}}
 * recordInfo → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *              "resultJson":"{\"resultUrls\":[\"...\"]}", "failMsg":"..."}}
 * تنبيه مهم: resultJson نصّ JSON داخل JSON يحتاج JSON.parse ثانيًا.
 * (إن تغيّر الشكل لاحقًا نتبع docs.kie.ai الرسمي — لا نخترع حقولًا)
 */
async function kieFetch(apiKey: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // انقطاع شبكة / timeout → مؤقت
    throw new ProviderError(0, e instanceof Error ? e.message : String(e));
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON — نعتمد الحالة فقط */
  }
  if (!res.ok || (typeof body.code === "number" && body.code !== 200)) {
    const status = (typeof body.code === "number" && body.code !== 200 ? body.code : res.status) as number;
    const msg = String(body.msg ?? body.message ?? res.statusText ?? "خطأ غير معروف من المزود");
    throw new ProviderError(status, msg);
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(apiKey, providerModel, input, type) {
    const payload: Record<string, unknown> = {
      model: providerModel,
      input: {
        prompt: input.prompt,
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        ...(input.aspectRatio && input.aspectRatio !== "auto" ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.background && input.background !== "auto" ? { background: input.background } : {}),
        ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
        ...(type === "video"
          ? {
              ...(input.enableAudio !== undefined ? { enable_audio: input.enableAudio } : {}),
              ...(input.duration ? { duration: input.duration } : {}),
            }
          : {}),
      },
    };
    const body = await kieFetch(apiKey, `${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = body.data as { taskId?: string } | undefined;
    const taskId = data?.taskId;
    if (!taskId) throw new ProviderError(500, "استجابة createTask من kie.ai بلا taskId");
    return { providerTaskId: taskId };
  },

  async checkTask(apiKey, providerTaskId) {
    const body = await kieFetch(apiKey, `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`);
    const data = (body.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string;
      progress?: number;
    };
    const state = data.state ?? "waiting";
    if (state === "success") {
      // resultJson نصّ يحتاج JSON.parse ثانيًا (شكل kie الموثق)
      let urls: string[] = [];
      try {
        const inner = JSON.parse(data.resultJson ?? "{}") as { resultUrls?: string[] };
        urls = Array.isArray(inner.resultUrls) ? inner.resultUrls.filter((u) => typeof u === "string" && u.startsWith("http")) : [];
      } catch {
        urls = [];
      }
      if (urls.length === 0) return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج صالحة" };
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: data.failMsg ?? "فشل المزود دون رسالة" };
    }
    // تقدير تقدم دافع من الحالة إن لم يرسل المزود رقمًا صريحًا
    const coarse = state === "generating" ? 45 : state === "queuing" ? 15 : 5;
    const progress = typeof data.progress === "number" && data.progress >= 0 && data.progress <= 100 ? data.progress : coarse;
    return { status: "processing", progress };
  },
};

const COMETAPI_BASE = process.env.COMETAPI_API_BASE || "https://api.cometapi.com";

/**
 * CometAPI — مزود ثانٍ:
 * - الصور: نقطة متوافقة مع OpenAI (v1/images/generations) تعيد url أو b64_json فورًا (متزامنة).
 * - الفيديو: نقطة مهام غير متزامنة بنفس نمط create/check.
 * نتحقق من الاستجابة بتحليل دفاعي — إن اختلف الشكل نلتزم بالشكل الحقيقي المقاس لا بعينه المفترض.
 */
async function cometFetch(apiKey: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ProviderError(0, e instanceof Error ? e.message : String(e));
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  if (!res.ok) {
    const errObj = (body.error ?? {}) as { message?: string; type?: string };
    const msg = String(errObj.message ?? body.message ?? body.msg ?? res.statusText ?? "خطأ من CometAPI");
    throw new ProviderError(res.status, msg);
  }
  return body;
}

function cometVideoStatus(s: unknown): "processing" | "completed" | "failed" {
  const v = String(s ?? "").toLowerCase();
  if (["completed", "succeeded", "success", "done", "finished"].includes(v)) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(v)) return "failed";
  return "processing";
}

function collectUrls(data: Record<string, unknown>): string[] {
  // تحليل دفاعي: نجمع أي روابط http(s) من الحقول الشائعة دون افتراض شكل واحد
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//.test(v)) out.push(v);
    else if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) push(val);
    }
  };
  push(data.video_url);
  push(data.url);
  push(data.videos);
  push(data.data);
  push(data.results);
  return Array.from(new Set(out));
}

export const cometapiAdapter: ProviderAdapter = {
  async createTask(apiKey, providerModel, input, type) {
    if (type === "image") {
      // الصور لدى CometAPI متزامنة — لا مهمة غير متزامنة لها
      throw new ProviderError(400, "model not found: use createImageSync for images at CometAPI");
    }
    const body = await cometFetch(apiKey, `${COMETAPI_BASE}/v1/video/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        ...(input.aspectRatio && input.aspectRatio !== "auto" ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.enableAudio !== undefined ? { enable_audio: input.enableAudio } : {}),
      }),
    });
    const taskId =
      (body.task_id as string) ??
      (body.taskId as string) ??
      ((body.data as Record<string, unknown> | undefined)?.task_id as string | undefined) ??
      ((body.data as Record<string, unknown> | undefined)?.taskId as string | undefined);
    if (!taskId) throw new ProviderError(500, "استجابة CometAPI بلا معرف مهمة");
    return { providerTaskId: taskId };
  },

  async createImageSync(apiKey, providerModel, input) {
    const body = await cometFetch(apiKey, `${COMETAPI_BASE}/v1/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        ...(input.aspectRatio && input.aspectRatio !== "auto" ? { size: input.aspectRatio } : {}),
        ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
      }),
    });
    const arr = (body.data as Array<Record<string, unknown>> | undefined) ?? [];
    const urls: string[] = [];
    for (const item of arr) {
      if (typeof item.url === "string" && item.url.startsWith("http")) urls.push(item.url);
      else if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
        // قاعدة «روابط فقط»: نحوّل b64 إلى data URI يُعاد للعميل — لا يُكتب أي ملف على القرص
        if (item.b64_json.length > 8_000_000) {
          throw new ProviderError(500, "النتيجة b64 أكبر من الحد المسموح (8MB)");
        }
        urls.push(`data:image/${input.outputFormat || "png"};base64,${item.b64_json}`);
      }
    }
    if (urls.length === 0) throw new ProviderError(500, "استجابة صور CometAPI بلا روابط أو بيانات");
    return { urls };
  },

  async checkTask(apiKey, providerTaskId) {
    const body = await cometFetch(apiKey, `${COMETAPI_BASE}/v1/video/generations/${encodeURIComponent(providerTaskId)}`);
    const status = cometVideoStatus(body.status ?? (body.data as Record<string, unknown> | undefined)?.status);
    if (status === "completed") {
      const urls = collectUrls(body);
      if (urls.length === 0) return { status: "failed", error: "اكتملت مهمة CometAPI دون روابط نتائج" };
      return { status: "completed", urls, progress: 100 };
    }
    if (status === "failed") {
      const errObj = (body.error ?? {}) as { message?: string };
      return { status: "failed", error: String(errObj.message ?? body.message ?? "فشل CometAPI دون رسالة") };
    }
    const rawProgress = Number(body.progress ?? (body.data as Record<string, unknown> | undefined)?.progress ?? NaN);
    const progress = Number.isFinite(rawProgress) && rawProgress >= 0 && rawProgress <= 100 ? rawProgress : 40;
    return { status: "processing", progress };
  },
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return provider === "kie" ? kieAdapter : cometapiAdapter;
}
