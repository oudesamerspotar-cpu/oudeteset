/**
 * /api/keys/{id} — تعطيل/تنشيط يدوي (PATCH) وحذف (DELETE).
 * التنشيط يُستخدم بعد شحن الرصيد لمفتاح كان مستنزفًا.
 */
import { deleteKey, getKey, updateKeyStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { status?: string };
    const status = body.status;
    if (status !== "active" && status !== "disabled" && status !== "exhausted") {
      return Response.json({ error: "الحالة المطلوبة غير صالحة — المسموح: active أو disabled" }, { status: 400 });
    }
    const existing = await getKey(id);
    if (!existing) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });

    await updateKeyStatus(id, status, status === "active" ? null : undefined);
    return Response.json({ ok: true, id, status });
  } catch (e) {
    return Response.json({ error: `تعذر تحديث المفتاح: ${e instanceof Error ? e.message : "خطأ غير معروف"}` }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const deleted = await deleteKey(id);
    if (!deleted) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: `تعذر حذف المفتاح: ${e instanceof Error ? e.message : "خطأ غير معروف"}` }, { status: 500 });
  }
}
