"use client";

/**
 * ب) لوحة المهام — إحصائيات + قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ.
 * لكل مهمة: النوع، شارة الحالة، شريط تقدم، الموديل، مقتطف الوصف، الوقت، الروابط عند الاكتمال،
 * رسالة الخطأ عند الفشل، وعدد المحاولات.
 */
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, ListVideo, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export interface TaskItem {
  id: string;
  type: "image" | "video" | "merge" | "slideshow";
  model: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attemptsCount: number;
  provider: string | null;
  createdAt: string;
}

export interface TasksStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const typeInfo: Record<TaskItem["type"], { label: string; icon: string }> = {
  image: { label: "صورة", icon: "🖼️" },
  video: { label: "فيديو", icon: "🎬" },
  merge: { label: "دمج", icon: "🔗" },
  slideshow: { label: "عرض صوري", icon: "🎞️" },
};

const statusInfo = (s: TaskItem["status"]) => {
  switch (s) {
    case "completed":
      return { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", label: "مكتملة", animated: false };
    case "failed":
      return { cls: "border-rose-500/40 bg-rose-500/10 text-rose-300", label: "فاشلة", animated: false };
    case "processing":
      return { cls: "border-amber-500/40 bg-amber-500/10 text-amber-300", label: "جارية", animated: true };
    default:
      return { cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400", label: "بالانتظار", animated: true };
  }
};

export function TasksBoard({ tick }: { tick: number }) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<TasksStats>({ total: 0, completed: 0, failed: 0, processing: 0 });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { tasks: TaskItem[]; stats: TasksStats };
        setTasks(data.tasks);
        setStats(data.stats);
      }
    } catch {
      /* نحتفظ بالقائمة الحالية */
    }
  }, []);

  useEffect(() => {
    const t0 = setTimeout(load, 0);
    const t = setInterval(load, 5_000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [load, tick]);

  const statChips: Array<{ label: string; value: number; cls: string }> = [
    { label: "الإجمالي", value: stats.total, cls: "text-zinc-200 border-zinc-700 bg-zinc-800/60" },
    { label: "مكتملة", value: stats.completed, cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" },
    { label: "فاشلة", value: stats.failed, cls: "text-rose-300 border-rose-500/40 bg-rose-500/10" },
    { label: "جارية", value: stats.processing, cls: "text-amber-300 border-amber-500/40 bg-amber-500/10" },
  ];

  return (
    <Card className="border-zinc-800 bg-zinc-900/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListVideo className="h-4 w-4 text-emerald-400" />
          لوحة المهام
        </CardTitle>
        <CardDescription className="text-xs">تتحدث تلقائيًا كل ~5 ثوانٍ — المحاولات مسجلة لكل مهمة (نجاح وفشل مع فئة الخطأ).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {/* شرائح الإحصائيات */}
        <div className="grid grid-cols-4 gap-2">
          {statChips.map((s) => (
            <div key={s.label} className={`rounded-lg border px-2 py-2 text-center ${s.cls}`}>
              <div className="text-lg font-bold leading-none">{s.value}</div>
              <div className="text-[10px] mt-1 opacity-90">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400">أحدث المهام</span>
          <Button variant="ghost" size="sm" onClick={load} className="text-zinc-400 gap-1">
            <RefreshCw className="h-3.5 w-3.5" />
            تحديث الآن
          </Button>
        </div>

        <div className="max-h-96 overflow-y-auto custom-scroll space-y-2 pe-1">
          {tasks.length === 0 ? (
            <p className="text-xs text-zinc-500 rounded-lg border border-dashed border-zinc-800 p-6 text-center">
              لا مهام بعد — ابدأ التوليد من أي عميل MCP متصل بـ <code dir="ltr">/mcp</code> وستظهر المهام هنا حية.
            </p>
          ) : (
            tasks.map((t) => {
              const st = statusInfo(t.status);
              const tp = typeInfo[t.type];
              return (
                <div key={t.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{tp.icon}</span>
                    <Badge variant="outline" className={st.cls}>
                      {st.label}
                    </Badge>
                    <span className="text-[11px] text-zinc-400">{tp.label}</span>
                    <code dir="ltr" className="text-[10px] text-zinc-500 truncate max-w-[16rem]">
                      {t.model}
                    </code>
                    {t.provider ? (
                      <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px]">
                        {t.provider}
                      </Badge>
                    ) : null}
                    <span className="ms-auto text-[10px] text-zinc-500">{new Date(t.createdAt).toLocaleString("ar")}</span>
                  </div>
                  {t.prompt ? <p className="text-xs text-zinc-300 leading-5 truncate" title={t.prompt}>{t.prompt}</p> : null}
                  {t.status === "processing" || t.status === "pending" ? (
                    <div className="flex items-center gap-2">
                      <Progress value={t.progress} className="h-1.5 flex-1" />
                      <span className="text-[10px] text-zinc-400 tabular-nums w-9 text-center">{t.progress}%</span>
                    </div>
                  ) : null}
                  {t.status === "failed" && t.errorMessage ? (
                    <p className="text-[11px] text-rose-300/90 leading-5 line-clamp-2" title={t.errorMessage}>
                      {t.errorMessage}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] text-zinc-500">محاولات: {t.attemptsCount}</span>
                    {t.resultUrls.map((u) =>
                      u.startsWith("http") ? (
                        <a
                          key={u}
                          href={u}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-emerald-300 hover:text-emerald-200 underline underline-offset-4"
                        >
                          <ExternalLink className="h-3 w-3" />
                          فتح النتيجة
                        </a>
                      ) : null,
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
