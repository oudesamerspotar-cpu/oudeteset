/** GET /api/tasks — أحدث المهام + الإحصائيات للوحة المهام (تُحدَّث تلقائيًا كل ~5 ثوانٍ من الواجهة) */
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 15)));
    const type = url.searchParams.get("type") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;

    const [tasks, stats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);
    return Response.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        model: t.model,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt.slice(0, 140),
        resultUrls: t.resultUrls ?? [],
        errorMessage: t.errorMessage,
        attemptsCount: t.attempts.length,
        provider: t.provider,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
    });
  } catch (e) {
    return Response.json({ error: `تعذر جلب المهام: ${e instanceof Error ? e.message : "خطأ غير معروف"}` }, { status: 500 });
  }
}
