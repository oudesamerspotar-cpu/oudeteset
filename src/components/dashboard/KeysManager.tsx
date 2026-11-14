"use client";

/**
 * أ) مدير المفاتيح — إضافة/تعطيل/تنشيط/حذف مفاتيح kie.ai و CometAPI.
 * القائمة تُخفا المفاتيح دائمًا (maskKey من الخادم) ولا يُعاد المفتاح الكامل إطلاقًا.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Plus, Trash2, Power, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface KeyItem {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  maskedKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const statusBadge = (s: KeyItem["status"]) =>
  s === "active"
    ? { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", label: "نشط" }
    : s === "exhausted"
      ? { cls: "border-amber-500/40 bg-amber-500/10 text-amber-300", label: "مستنزف" }
      : { cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400", label: "معطّل" };

const providerBadge = (p: KeyItem["provider"]) =>
  p === "kie" ? { cls: "border-violet-500/40 bg-violet-500/10 text-violet-300", label: "kie.ai" } : { cls: "border-teal-500/40 bg-teal-500/10 text-teal-300", label: "CometAPI" };

export function KeysManager({ refreshVersion, onChanged }: { refreshVersion: number; onChanged?: () => void }) {
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { keys: KeyItem[] };
        setKeys(data.keys);
      }
    } catch {
      /* نحتفظ بالقائمة الحالية */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, refreshVersion]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      setMessage({ kind: "error", text: "الصق مفتاح API الكامل أولًا." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok) {
        setMessage({ kind: "ok", text: "أُضيف المفتاح — سيُجرَّب أولًا حسب ترتيب الإضافة." });
        setApiKey("");
        setLabel("");
        await load();
        onChanged?.();
      } else {
        setMessage({ kind: "error", text: data.error ?? "فشل إضافة المفتاح." });
      }
    } catch {
      setMessage({ kind: "error", text: "تعذر الاتصال بالخادم." });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (k: KeyItem) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    await load();
    onChanged?.();
  };

  const remove = async (k: KeyItem) => {
    if (!window.confirm(`حذف المفتاح ${k.maskedKey}؟`)) return;
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    await load();
    onChanged?.();
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-emerald-400" />
          مدير المفاتيح
        </CardTitle>
        <CardDescription className="text-xs leading-5">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {/* نموذج الإضافة */}
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">المزود</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="bg-zinc-950 border-zinc-800">
                  <SelectValue placeholder="اختر المزود" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kie">kie.ai</SelectItem>
                  <SelectItem value="cometapi">CometAPI</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">تسمية (اختياري)</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="مثال: حساب رئيسي"
                className="bg-zinc-950 border-zinc-800"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-400">مفتاح API</Label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="الصق المفتاح الكامل هنا"
              type="password"
              dir="ltr"
              className="bg-zinc-950 border-zinc-800 text-left"
            />
          </div>
          <Button onClick={addKey} disabled={busy} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white gap-1.5">
            <Plus className="h-4 w-4" />
            {busy ? "جارٍ الإضافة…" : "إضافة المفتاح"}
          </Button>
          {message ? (
            <p className={`text-xs leading-5 ${message.kind === "error" ? "text-rose-300" : "text-emerald-300"}`} role="alert">
              {message.kind === "error" ? <AlertTriangle className="inline h-3.5 w-3.5 me-1" /> : null}
              {message.text}
            </p>
          ) : null}
        </div>

        {/* القائمة */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400">المفاتيح ({keys.length}) — مرتبة بترتيب التجربة</span>
          <Button variant="ghost" size="sm" onClick={load} className="text-zinc-400 gap-1">
            <RefreshCw className="h-3.5 w-3.5" />
            تحديث
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto custom-scroll space-y-2 pe-1">
          {keys.length === 0 ? (
            <p className="text-xs text-zinc-500 rounded-lg border border-dashed border-zinc-800 p-4 text-center">
              لا توجد مفاتيح بعد — أضف أول مفتاح من النموذج أعلاه لبدء التوليد.
            </p>
          ) : (
            keys.map((k, i) => {
              const st = statusBadge(k.status);
              const pv = providerBadge(k.provider);
              return (
                <div key={k.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] text-zinc-500 font-mono">#{i + 1}</span>
                    <Badge variant="outline" className={pv.cls}>
                      {pv.label}
                    </Badge>
                    <Badge variant="outline" className={st.cls}>
                      {st.label}
                    </Badge>
                    <code dir="ltr" className="text-[11px] text-zinc-300 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5">
                      {k.maskedKey}
                    </code>
                    <div className="ms-auto flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggle(k)} className="text-zinc-300 gap-1 h-8">
                        <Power className="h-3.5 w-3.5" />
                        {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(k)} className="text-rose-300 hover:text-rose-200 gap-1 h-8">
                        <Trash2 className="h-3.5 w-3.5" />
                        حذف
                      </Button>
                    </div>
                  </div>
                  {k.label ? <p className="text-xs text-zinc-400">التسمية: {k.label}</p> : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                    <span>استخدام: {k.usageCount}</span>
                    <span className="text-emerald-400/80">نجاح: {k.successCount}</span>
                    <span className="text-rose-400/80">فشل: {k.failCount}</span>
                    {k.lastUsedAt ? <span>آخر استخدام: {new Date(k.lastUsedAt).toLocaleString("ar")}</span> : null}
                  </div>
                  {k.lastError ? (
                    <p className="text-[11px] text-rose-300/80 truncate" title={k.lastError}>
                      آخر خطأ: {k.lastError}
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
