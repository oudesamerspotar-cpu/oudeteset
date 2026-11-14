/**
 * تصنيف موحّد لأخطاء المزودين — قلب سياسة التبديل التسلسلي (قسم 4.2 من المواصفة).
 * كل خطأ قادم من مزود خارجي يُغلَّف بـ ProviderError ثم يُصنَّف بدالة واحدة.
 */

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** خطأ مزود خارجي مع حالة HTTP (status=0 عند فشل الشبكة/timeout) */
export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/* أنماط الرسائل — نفحص الرسالة قبل حالة 400 لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400 */
const DISABLED_PATTERNS = /invalid api key|unauthorized|forbidden|authentication/i;
const EXHAUSTED_PATTERNS = /insufficient|quota|balance|credit|out of credits|exhausted|充值/i;
const PROVIDER_MODEL_PATTERNS = /model not found|unsupported model/i;

/**
 * تصنيف الخطأ وفق جدول 4.2:
 * - disabled  : 401/403 أو رسالة مفتاح غير صالح → تعطيل المفتاح والانتقال للتالي
 * - exhausted : 402 أو رسالة نفاد رصيد (قبل فحص 400!) → تعليم المفتاح مستنزفًا والانتقال للتالي
 * - provider  : موديل غير مدعوم لدى المزود مع 400/404/422 → الانتقال للتالي
 * - params    : 400/422 معطيات → توقف فورًا (تبديل المفاتيح لن يحل خطأ معطيات)
 * - temporary : 429/5xx/شبكة/timeout → الانتقال للتالي مع بقاء المفتاح سليمًا
 */
export function classifyProviderError(err: unknown): ErrorClass {
  const status = err instanceof ProviderError ? err.status : 0;
  const msg = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403 || DISABLED_PATTERNS.test(msg)) return "disabled";
  if (status === 402 || EXHAUSTED_PATTERNS.test(msg)) return "exhausted";
  if (PROVIDER_MODEL_PATTERNS.test(msg) && [400, 404, 422].includes(status)) return "provider";
  if (status === 400 || status === 422) return "params";
  // 404 العادي وغيره: مؤقت (الانتقال للمفتاح التالي آمن دائمًا)
  return "temporary";
}

/**
 * نمط فشل منتصف المهمة المرتبط بمشكلات مفتاح/رصيد (قسم 4.3.2):
 * إذا جاءت رسالة فشل المزود مطابقة لهذا النمط أعيد إنشاء نفس المهمة بنفس task_id
 * على المفتاح التالي — العميل لا يرى شيئًا من هذا إطلاقًا.
 */
const KEY_FAIL_PATTERNS =
  /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|exhausted|充值/i;

export function isKeyRelatedFailure(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return KEY_FAIL_PATTERNS.test(msg);
}
