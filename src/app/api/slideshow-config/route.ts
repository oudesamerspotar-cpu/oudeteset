/**
 * GET /api/slideshow-config — يوفر لعناصر الواجهة (المتصفح) عنوان خدمة الدمج
 * لرفع الصور ومعالجتها مباشرة (خدمة الدمج تفتح CORS بالكامل).
 * MERGER_API_BASE متغير خادمي — لا يُكشف أي سر آخر هنا.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const base = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
  return Response.json(
    { mergerBase: base, configured: base.length > 0 },
    { headers: { "Cache-Control": "no-store" } },
  );
}
