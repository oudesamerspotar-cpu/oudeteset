/**
 * سجل الموديلات — المصدر الوحيد لأسماء الموديلات وصيغها البديلة والمزودين الذين يخدمونها.
 * الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL / KIE_VIDEO_MODEL / COMETAPI_IMAGE_MODEL / COMETAPI_VIDEO_MODEL).
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسَل لكل مزود
}

const env = (k: string): string | undefined => process.env[k] || undefined;

export const IMAGE_MODEL: ModelDef = {
  canonical: "gpt-image-2-6/flare-text-to-image",
  aliases: ["gpt-image-2.6/flare-text-to-image"],
  type: "image",
  providers: ["kie", "cometapi"],
  providerModel: {
    // لاحظ: CometAPI يستخدم صيغة النقاط (2.6) بينما kie يحتفظ بالشرطة (2-6) — كما في التوثيقين
    kie: env("KIE_IMAGE_MODEL") ?? "gpt-image-2-6/flare-text-to-image",
    cometapi: env("COMETAPI_IMAGE_MODEL") ?? "gpt-image-2.6-flare-text-to-image",
  },
};

export const VIDEO_MODEL: ModelDef = {
  canonical: "grok-imagine-video-1-5-preview",
  aliases: ["grok-imagine-video-1.5-preview"],
  type: "video",
  providers: ["kie", "cometapi"],
  providerModel: {
    kie: env("KIE_VIDEO_MODEL") ?? "grok-imagine-video-1-5-preview",
    cometapi: env("COMETAPI_VIDEO_MODEL") ?? "grok-imagine-video-1-5-preview",
  },
};

export const MODELS: ModelDef[] = [IMAGE_MODEL, VIDEO_MODEL];

export const MERGE_MODEL = "video-merger"; // اسم ثابت لمهام الدمج (provider = merger)

/** توحيد اسم الموديل عبر الاسماء البديلة — يعيد canonical أو null إن كان غير معروف */
export function normalizeModel(name: string | undefined | null): ModelDef | null {
  if (!name) return null;
  const n = String(name).trim();
  for (const m of MODELS) {
    if (m.canonical === n || m.aliases.includes(n)) return m;
  }
  return null;
}

/** الموديل الافتراضي لكل نوع وسائط */
export function defaultModelFor(type: MediaType): ModelDef {
  return type === "image" ? IMAGE_MODEL : VIDEO_MODEL;
}
