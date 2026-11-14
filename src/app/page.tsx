"use client";

/**
 * لوحة الإدارة — صفحة واحدة عربية RTL بثلاث بطاقات:
 * أ) مدير المفاتيح ب) لوحة المهام ج) ربط السيرفر
 * الهيدر يعرض حالة /api/health (شارة Turso متصل خضراء / غير متصل حمراء).
 */
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Activity, PlugZap, ShieldCheck, Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { KeysManager, type KeyItem } from "@/components/dashboard/KeysManager";
import { TasksBoard, type TasksStats } from "@/components/dashboard/TasksBoard";
import { ServerConnect } from "@/components/dashboard/ServerConnect";

export interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [keysVersion, setKeysVersion] = useState(0); // لتحديث قائمة المفاتيح بعد أي إضافة/تعطيل/حذف
  const [statsTick, setStatsTick] = useState(0);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) setHealth((await res.json()) as HealthInfo);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    // تأجيل التحميل الأول خارج مسار الـ effect المتزامن
    const t0 = setTimeout(loadHealth, 0);
    const t = setInterval(loadHealth, 15_000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [loadHealth]);

  const refreshKeys = useCallback(() => setKeysVersion((v) => v + 1), []);
  const refreshTasks = useCallback(() => setStatsTick((v) => v + 1), []);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* الهيدر — الحالة العامة للسيرفر */}
      <header className="border-b border-zinc-800/80 bg-zinc-900/60 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-7xl px-4 py-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
              <Activity className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">MCP Media Generator</h1>
              <p className="text-xs text-zinc-400">توليد الصور والفيديو بالذكاء الاصطناعي + دمج المقاطع — خادم MCP مع تبديل مفاتيح تسلسلي</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 ms-auto">
            {/* شارة قاعدة البيانات */}
            <Badge
              variant="outline"
              className={
                health?.ok
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 gap-1.5"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-300 gap-1.5"
              }
            >
              <Database className="h-3.5 w-3.5" />
              {health?.ok ? "Turso متصل" : "Turso غير متصل"}
            </Badge>
            <Badge
              variant="outline"
              className={
                health?.merger.healthy
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              }
            >
              خدمة الدمج: {health?.merger.healthy ? "جاهزة" : "غير متاحة"}
            </Badge>
            {health?.authRequired ? (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300 gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                محمي بـ MCP_ACCESS_TOKEN
              </Badge>
            ) : null}
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-6 space-y-6">
        <div className="grid gap-6 xl:grid-cols-3">
          {/* أ) مدير المفاتيح */}
          <section className="xl:col-span-1">
            <KeysManager refreshVersion={keysVersion} onChanged={refreshTasks} />
          </section>

          {/* ب) لوحة المهام */}
          <section className="xl:col-span-2">
            <TasksBoard tick={statsTick} />
          </section>
        </div>

        {/* ج) ربط السيرفر */}
        <section>
          <ServerConnect health={health} />
        </section>
      </main>

      <footer className="border-t border-zinc-800/80 mt-auto">
        <div className="mx-auto max-w-7xl px-4 py-3 text-xs text-zinc-500 flex flex-wrap gap-x-6 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            المفاتيح مُخفاة دائمًا في كل الاستجابات والسجلات
          </span>
          <span>ترتيب التجربة تسلسلي صارم بترتيب الإضافة — تبديل فوري عند أي خطأ دون توقف المهمة</span>
        </div>
      </footer>
    </div>
  );
}
