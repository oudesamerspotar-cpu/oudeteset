/**
 * صياغة الردود العربية للأدوات (قسم 8 من المواصفة).
 * قاعدة صارمة: لا يخرج للعميل أي ذكر لمفاتيح API أو رصيد — التبديل صامت من وجهة نظره.
 * المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية.
 */
import type { TaskRow } from "@/lib/turso";
import { MODELS } from "@/lib/models";

export function formatNoKeys(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

export function formatBadModel(name: string): string {
  const available = MODELS.map((m) => m.canonical).join(" ، ");
  return `❌ موديل غير معروف: ${name}. المتاح: ${available}`;
}

export function formatProcessing(task: TaskRow): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function formatCompleted(task: TaskRow): string {
  const urls = (task.resultUrls ?? []).filter((u) => /^(https?|data):/.test(u));
  const lines: string[] = [];
  if (task.type === "image") {
    lines.push("✅ تم توليد الصورة بنجاح");
    if (urls[0] && urls[0].startsWith("http")) lines.push("", `![image](${urls[0]})`, "", `الرابط المباشر: ${urls[0]}`);
    else if (urls[0]) lines.push("", `الرابط المباشر: ${urls[0]}`);
    for (const u of urls.slice(1)) lines.push("", `الرابط المباشر: ${u}`);
  } else if (task.type === "slideshow") {
    lines.push("✅ تم إنشاء الفيديو من الصور بنجاح (رأسي 9:16 — تحريك خفيف على كل صورة)");
    for (const u of urls) lines.push("", `الرابط المباشر: ${u}`);
    // ملف العرض الصوري يُخزَّن في خدمة الدمج بنفس صلاحية ملفات الدمج
    lines.push("", "⚠️ ملف الفيديو يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
  } else if (task.type === "video") {
    lines.push("✅ تم توليد الفيديو بنجاح");
    for (const u of urls) lines.push("", `الرابط المباشر: ${u}`);
  } else {
    lines.push("✅ تم دمج المقاطع بنجاح");
    for (const u of urls) lines.push("", `الرابط المباشر: ${u}`);
    // مذكور حرفيًا حسب المواصفة — ملفات الدمج تُحذف بعد 24 ساعة
    lines.push("", "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
  }
  return lines.join("\n");
}

export function formatFailed(task: TaskRow): string {
  return `❌ فشلت المهمة: ${(task.errorMessage ?? "سبب غير معروف").slice(0, 400)}`;
}

/** الصياغة النهائية لأي مهمة حسب حالتها */
export function formatTaskForClient(task: TaskRow): { text: string; isError: boolean } {
  if (task.status === "completed") return { text: formatCompleted(task), isError: false };
  if (task.status === "failed") return { text: formatFailed(task), isError: true };
  return { text: formatProcessing(task), isError: false };
}
