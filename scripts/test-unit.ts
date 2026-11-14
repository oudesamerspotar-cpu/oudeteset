/**
 * اختبارات وحدة لطبقة المشروع الأول — دوال نقية بلا قاعدة بيانات:
 * 1) classifyProviderError: مصفوفة التصنيف الكاملة (جدول 4.2)
 * 2) maskKey: إخفاء المفاتيح
 * 3) normalizeModel: توحيد الأسماء البديلة
 * 4) isKeyRelatedFailure: نمط فشل منتصف المهمة
 * التشغيل: bun run scripts/test-unit.ts
 */
import { classifyProviderError, isKeyRelatedFailure, ProviderError } from "../src/lib/errors";
import { maskKey } from "../src/lib/keys";
import { normalizeModel } from "../src/lib/models";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("── 1) classifyProviderError — جدول 4.2 ──");
assert("401 → disabled", classifyProviderError(new ProviderError(401, "any")) === "disabled");
assert("403 → disabled", classifyProviderError(new ProviderError(403, "forbidden access")) === "disabled");
assert("رسالة invalid api key مع 400 → disabled (الرسالة أولًا)", classifyProviderError(new ProviderError(400, "invalid api key provided")) === "disabled");
assert("402 → exhausted", classifyProviderError(new ProviderError(402, "payment required")) === "exhausted");
assert("رسالة insufficient balance مع 400 → exhausted (نفحص الرسالة قبل 400)", classifyProviderError(new ProviderError(400, "insufficient balance")) === "exhausted");
assert("رسالة quota بالصيني 充值 مع 400 → exhausted", classifyProviderError(new ProviderError(400, "please 充值 to continue")) === "exhausted");
assert("model not found مع 404 → provider", classifyProviderError(new ProviderError(404, "model not found")) === "provider");
assert("unsupported model مع 422 → provider", classifyProviderError(new ProviderError(422, "unsupported model for this account")) === "provider");
assert("400 عادي → params (توقف فوري)", classifyProviderError(new ProviderError(400, "bad request body")) === "params");
assert("422 عادي → params", classifyProviderError(new ProviderError(422, "validation failed")) === "params");
assert("429 → temporary", classifyProviderError(new ProviderError(429, "rate limited")) === "temporary");
assert("500 → temporary", classifyProviderError(new ProviderError(500, "internal error")) === "temporary");
assert("فشل شبكة (status 0) → temporary", classifyProviderError(new ProviderError(0, "fetch failed")) === "temporary");
assert("404 عادي بلا رسالة موديل → temporary", classifyProviderError(new ProviderError(404, "no such endpoint")) === "temporary");

console.log("── 2) isKeyRelatedFailure — فشل منتصف المهمة (قسم 4.3.2) ──");
assert("insufficient balance → متعلق بالمفتاح", isKeyRelatedFailure("Error: insufficient balance for this request"));
assert("HTTP 402 داخل النص → متعلق", isKeyRelatedFailure("upstream returned 402"));
assert("رسالة عادية → غير متعلق", !isKeyRelatedFailure("content policy violation"));
assert("نص فارغ → غير متعلق", !isKeyRelatedFailure("") && !isKeyRelatedFailure(null));

console.log("── 3) maskKey — إخفاء إلزامي ──");
assert("مفتاح طويل: أول 7 + نقاط + آخر 4", maskKey("sk-prod-1234567890abcdef") === "sk-prod••••••••cdef", maskKey("sk-prod-1234567890abcdef"));
assert("مفتاح قصير: أول 3 + نقاط", maskKey("abc12345") === "abc••••", maskKey("abc12345"));
assert("لا يُعاد المفتاح كاملًا أبدًا", !maskKey("short").includes("short"));

console.log("── 4) normalizeModel — توحيد الأسماء ──");
assert("الاسم القانوني للصور", normalizeModel("gpt-image-2-6/flare-text-to-image")?.canonical === "gpt-image-2-6/flare-text-to-image");
assert("البديل بالنقاط 2.6 يوحَّد", normalizeModel("gpt-image-2.6/flare-text-to-image")?.canonical === "gpt-image-2-6/flare-text-to-image");
assert("الاسم القانوني للفيديو", normalizeModel("grok-imagine-video-1-5-preview")?.type === "video");
assert("البديل بالنقاط 1.5 يوحَّد", normalizeModel("grok-imagine-video-1.5-preview")?.canonical === "grok-imagine-video-1-5-preview");
assert("اسم مجهول → null", normalizeModel("gpt-image-3") === null);
assert("قيم فارغة → null", normalizeModel(undefined) === null && normalizeModel("") === null);

console.log(`\n═══ نتيجة اختبارات الوحدة: ${pass} ناجح، ${fail} فاشل ═══`);
process.exit(fail === 0 ? 0 : 1);
