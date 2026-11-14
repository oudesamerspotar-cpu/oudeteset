/** GET /api/health — جهوزية الخدمة وقاعدة البيانات وخدمة الدمج وقائمة الموديلات */
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { MERGER_BASE } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const database = await dbHealthy();

  // فحص جهوزية خدمة الدمج: GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  let mergerHealthy = false;
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4_000) });
    mergerHealthy = res.ok;
  } catch {
    mergerHealthy = false;
  }

  const body = {
    ok: database,
    database: database ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: MERGER_BASE, healthy: mergerHealthy },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
