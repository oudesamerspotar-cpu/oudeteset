/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (قسم 7 من المواصفة).
 * بلا مفاتيح أو توثيق. تحليل الحالة دفاعي بالكامل:
 * - أكمل: done|completed|complete|success|succeeded|finished — فشل: error|failed|failure|cancelled
 * - progress قد يأتي كسرًا 0..1 → نضربه في 100
 * - رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا وبقي jobId فاضبط رابط /video مباشرة
 * - قد يرد الجسم فيه error دون حقل status → عاملها failed فورًا
 */

export const MERGER_BASE: string = process.env.MERGER_API_BASE || "https://xxxxxxxx";

export interface MergeJobStatus {
  state: "queued" | "processing" | "completed" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  error?: string;
}

export interface MergeJobCreated {
  jobId: string;
  status: string;
  expiresAt?: string;
}

export class MergerError extends Error {
  status: number; // حالة HTTP أو 0 عند فشل الشبكة لدينا
  constructor(status: number, message: string) {
    super(message);
    this.name = "MergerError";
    this.status = status;
  }
}

async function mergerFetch(url: string, init?: RequestInit, timeoutMs = 320_000): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة
    throw new MergerError(0, e instanceof Error ? e.message : String(e));
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  return { status: res.status, body };
}

/** إنشاء مهمة دمج من روابط مباشرة */
export async function createMergeJob(urls: string[]): Promise<MergeJobCreated> {
  const { status, body } = await mergerFetch(`${MERGER_BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  }, 20_000);
  if (status < 200 || status >= 300) {
    // خطأ HTTP معلن من الخدمة = فشل حتمي فوري (لا إعادة محاولة) — نحمله للمنسق كي يصنّفه
    throw new MergerError(status, String(body.error ?? body.message ?? `HTTP ${status}`));
  }
  const jobId = body.jobId as string | undefined;
  if (!jobId) throw new MergerError(500, "استجابة إنشاء مهمة الدمج بلا jobId");
  return { jobId, status: String(body.status ?? "queued"), expiresAt: body.expiresAt as string | undefined };
}

/* ===== العرض الصوري (صور ← فيديو رأسي 9:16 بتحريك خفيف) ===== */

export interface SlideshowJobCreated {
  jobId: string;
  imageCount: number;
  clipSeconds: number;
  expiresAt?: string;
}

export interface SlideshowClipState {
  seq: number;
  name: string;
  kind: "prompt" | "url" | "file";
  ready: boolean;
  size: number;
  imageReady: boolean;
}

export interface SlideshowJobStatus {
  status: string;
  progress: number;
  imageCount: number;
  clipSeconds: number;
  clipsReady: number;
  imagesReady: number;
  clips: SlideshowClipState[];
  videoUrl?: string;
  error?: string;
}

/** إنشاء مهمة عرض صوري من روابط صور مباشرة (4–8 صور) */
export async function createSlideshowJob(imageUrls: string[], clipSeconds = 15): Promise<SlideshowJobCreated> {
  const { status, body } = await mergerFetch(`${MERGER_BASE}/api/slideshow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images: imageUrls, clip_seconds: clipSeconds }),
  }, 20_000);
  if (status < 200 || status >= 300) {
    throw new MergerError(status, String(body.error ?? body.message ?? `HTTP ${status}`));
  }
  const jobId = body.jobId as string | undefined;
  if (!jobId) throw new MergerError(500, "استجابة إنشاء مهمة العرض الصوري بلا jobId");
  return {
    jobId,
    imageCount: Number(body.imageCount ?? imageUrls.length),
    clipSeconds: Number(body.clipSeconds ?? clipSeconds),
    expiresAt: body.expiresAt as string | undefined,
  };
}

/** إنشاء مهمة عرض صوري من أوصاف مشاهد نصية — كل وصف تولَّد صورته من خدمة مجانية بلا مفتاح (Pollinations) */
export async function createSlideshowFromPrompts(prompts: string[], clipSeconds = 15): Promise<SlideshowJobCreated> {
  const { status, body } = await mergerFetch(`${MERGER_BASE}/api/slideshow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompts, clip_seconds: clipSeconds }),
  }, 20_000);
  if (status < 200 || status >= 300) {
    throw new MergerError(status, String(body.error ?? body.message ?? `HTTP ${status}`));
  }
  const jobId = body.jobId as string | undefined;
  if (!jobId) throw new MergerError(500, "استجابة إنشاء مهمة العرض الصوري بلا jobId");
  return {
    jobId,
    imageCount: Number(body.imageCount ?? prompts.length),
    clipSeconds: Number(body.clipSeconds ?? clipSeconds),
    expiresAt: body.expiresAt as string | undefined,
  };
}

/** نتيجة خطوة توليد صورة مشهد (لمصادر prompts) — مُميَّز بمفتاح state ودون رميات */
export type SlideshowImageStepResult =
  | { state: "ok"; cached: boolean; size?: number }
  | { state: "rateLimited"; retryAfter: number }
  | { state: "serviceDown"; message: string }
  | { state: "mergerError"; status: number; message: string }
  | { state: "networkError"; message: string };

/**
 * توليد صورة مشهد من وصفه (خدمة مجانية بلا مفتاح) وتخزينها لدى خدمة الدمج.
 * مهلة طويرة لأن الخدمة قد تنتظر داخليًا حد الخدمة المجاني (~45 ثانية) ثم تولّد.
 * لا ترمي أبدًا — كل الحالات في النوع Union ليتقرر مصير المهمة في المُستدعي بوضوح.
 */
export async function generateSlideshowImage(jobId: string, seq: number): Promise<SlideshowImageStepResult> {
  let status: number;
  let body: Record<string, unknown>;
  try {
    const r = await mergerFetch(
      `${MERGER_BASE}/api/slideshow/${encodeURIComponent(jobId)}/image?seq=${seq}`,
      { method: "POST" },
      150_000,
    );
    status = r.status;
    body = r.body;
  } catch (e) {
    return { state: "networkError", message: e instanceof Error ? e.message : String(e) };
  }
  if (status === 429) {
    return { state: "rateLimited", retryAfter: Number(body.retryAfter) > 0 ? Number(body.retryAfter) : 45 };
  }
  if (status === 503) {
    return { state: "serviceDown", message: String(body.error ?? "خدمة توليد الصور المجانية غير متاحة حاليًا") };
  }
  if (status >= 400) {
    return { state: "mergerError", status, message: String(body.error ?? `HTTP ${status}`) };
  }
  return { state: "ok", cached: Boolean(body.cached), size: typeof body.size === "number" ? body.size : undefined };
}

/** معالجة صورة واحدة: تحويلها لمقطع بتحريك خفيف (يستغرق ~5–40 ثانية لكل صورة) */
export async function processSlideshowClip(jobId: string, seq: number): Promise<void> {
  const { status, body } = await mergerFetch(
    `${MERGER_BASE}/api/slideshow/${encodeURIComponent(jobId)}/clip?seq=${seq}`,
    { method: "POST" },
    300_000,
  );
  if (status >= 400) {
    throw new MergerError(status, String(body.error ?? `HTTP ${status}`));
  }
}

/** الدمج النهائي للمقاطع في فيديو واحد — سريع (-c copy) */
export async function mergeSlideshow(jobId: string): Promise<{ videoUrl: string; downloadUrl?: string; duration?: number; resolution?: string; size?: number }> {
  const { status, body } = await mergerFetch(`${MERGER_BASE}/api/slideshow/${encodeURIComponent(jobId)}/merge`, { method: "POST" }, 180_000);
  if (status >= 400) {
    throw new MergerError(status, String(body.error ?? `HTTP ${status}`));
  }
  const videoUrl =
    (typeof body.videoUrl === "string" && body.videoUrl.startsWith("http") && body.videoUrl) ||
    (typeof body.downloadUrl === "string" && body.downloadUrl.startsWith("http") && body.downloadUrl) ||
    `${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/video`;
  return {
    videoUrl,
    downloadUrl: typeof body.downloadUrl === "string" ? body.downloadUrl : undefined,
    duration: typeof body.duration === "number" ? body.duration : undefined,
    resolution: typeof body.resolution === "string" ? body.resolution : undefined,
    size: typeof body.size === "number" ? body.size : undefined,
  };
}

/** حالة مهمة العرض الصوري بالتفصيل (clips جاهزة/متبقية) */
export async function getSlideshowJob(jobId: string): Promise<SlideshowJobStatus> {
  const { status, body } = await mergerFetch(`${MERGER_BASE}/api/slideshow/${encodeURIComponent(jobId)}`, { method: "GET" }, 15_000);
  if (status === 404) {
    return { status: "missing", progress: 0, imageCount: 0, clipSeconds: 15, clipsReady: 0, imagesReady: 0, clips: [], error: "مهمة العرض الصوري غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  if (status >= 400) {
    throw new MergerError(status, String(body.error ?? body.message ?? `HTTP ${status}`));
  }
  const clips = Array.isArray(body.clips) ? (body.clips as Record<string, unknown>[]) : [];
  return {
    status: String(body.status ?? "unknown"),
    progress: Number(body.progress ?? 0),
    imageCount: Number(body.imageCount ?? clips.length),
    clipSeconds: Number(body.clipSeconds ?? 15),
    clipsReady: Number(body.clipsReady ?? 0),
    imagesReady: Number(body.imagesReady ?? 0),
    clips: clips.map((c) => ({
      seq: Number(c.seq ?? 0),
      name: String(c.name ?? ""),
      kind: c.kind === "prompt" ? "prompt" : c.kind === "file" ? "file" : "url",
      imageReady: c.kind === "prompt" ? Boolean(c.imageReady) : true,
      ready: Boolean(c.ready),
      size: Number(c.size ?? 0),
    })),
    videoUrl: typeof body.videoUrl === "string" ? body.videoUrl : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
  };
}

/** تنفيذ الدمج (يستغرق ~10–15 ثانية blocking) — يُستدعى خلفيًا وبمرة واحدة فقط */
export async function processMergeJob(jobId: string): Promise<void> {
  const { status, body } = await mergerFetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" });
  if (status >= 400) {
    throw new MergerError(status, String(body.error ?? `HTTP ${status}`));
  }
}

const DONE_STATES = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAIL_STATES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

/** جلب حالة المهمة مع التحليل الدفاعي الكامل */
export async function getMergeJob(jobId: string): Promise<MergeJobStatus> {
  const { status, body } = await mergerFetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 15_000);
  if (status === 404) {
    // المهمة غير موجودة (حُذفت أو انتهت صلاحيتها) → فشل نهائي
    return { state: "failed", progress: 0, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  if (status >= 400) {
    // خطأ HTTP معلن من الخدمة بجسم error → فشل نهائي فوري
    throw new MergerError(status, String(body.error ?? body.message ?? `HTTP ${status}`));
  }

  const rawState = String(body.status ?? "").toLowerCase();
  const hasError = typeof body.error === "string" && body.error.length > 0;

  // جسم فيه error دون حقل status → failed فورًا (دفاعي)
  if (!rawState && hasError) {
    return { state: "failed", progress: 0, error: String(body.error) };
  }

  let state: MergeJobStatus["state"] = "processing";
  if (DONE_STATES.has(rawState)) state = "completed";
  else if (FAIL_STATES.has(rawState) || (hasError && !rawState)) state = "failed";
  else if (rawState === "queued" || rawState === "uploading") state = "queued";

  if (state === "failed") {
    return { state, progress: 0, error: String(body.error ?? "فشل الدمج دون رسالة") };
  }

  // progress كسر 0..1 → ×100
  let progress = Number(body.progress ?? 0);
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  if (progress > 0 && progress <= 1) progress = progress * 100;
  if (progress > 100) progress = 100;

  // رابط النتيجة: videoUrl ثم downloadUrl ثم ضبط /video من jobId
  const videoUrl =
    (typeof body.videoUrl === "string" && body.videoUrl.startsWith("http") && body.videoUrl) ||
    (typeof body.downloadUrl === "string" && body.downloadUrl.startsWith("http") && body.downloadUrl) ||
    `${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/video`;

  return { state, progress, videoUrl };
}
