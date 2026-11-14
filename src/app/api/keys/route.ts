/**
 * /api/keys — إدارة مفاتيح API للواجهة.
 * GET: القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) — لا يُعاد المفتاح الكامل في أي استجابة.
 * POST: إضافة مفتاح مع رفض التكرار لنفس المزود.
 */
import { insertKey, listKeys } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = new Set(["kie", "cometapi"]);

function maskRow(k: { id: string; provider: string; label: string; apiKey: string; status: string; usageCount: number; successCount: number; failCount: number; lastUsedAt: string | null; lastCheckedAt: string | null; lastError: string | null; createdAt: string }) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.apiKey),
    status: k.status,
    usageCount: k.usageCount,
    successCount: k.successCount,
    failCount: k.failCount,
    lastUsedAt: k.lastUsedAt,
    lastCheckedAt: k.lastCheckedAt,
    lastError: k.lastError,
    createdAt: k.createdAt,
  };
}

export async function GET(): Promise<Response> {
  try {
    const keys = await listKeys();
    return Response.json({ keys: keys.map(maskRow) });
  } catch (e) {
    return Response.json({ error: `تعذر جلب المفاتيح: ${e instanceof Error ? e.message : "خطأ غير معروف"}` }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = String(body.provider ?? "").trim();
    const apiKey = String(body.api_key ?? "").trim();
    const label = String(body.label ?? "").trim().slice(0, 100);

    if (!PROVIDERS.has(provider)) {
      return Response.json({ error: "المزود غير معروف — الاختيارات المتاحة: kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey || apiKey.length < 8) {
      return Response.json({ error: "المفتاح قصير جدًا أو فارغ — الصق المفتاح الكامل من حساب المزود" }, { status: 400 });
    }

    const created = await insertKey({ provider, apiKey, label });
    if (!created) {
      return Response.json({ error: "هذا المفتاح مُضاف مسبقًا لدى نفس المزود — لا حاجة لإضافته مرتين" }, { status: 409 });
    }
    return Response.json({ ok: true, key: maskRow(created) }, { status: 201 });
  } catch (e) {
    return Response.json({ error: `تعذر إضافة المفتاح: ${e instanceof Error ? e.message : "خطأ غير معروف"}` }, { status: 500 });
  }
}
