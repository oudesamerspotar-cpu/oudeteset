/** أدوات مساندة لإدارة المفاتيح — إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات */

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 — وللمفاتيح القصيرة أول 3 + •••• */
export function maskKey(key: string): string {
  if (key.length >= 12) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  if (key.length > 3) return `${key.slice(0, 3)}••••`;
  return "••••";
}
