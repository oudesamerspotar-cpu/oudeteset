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
