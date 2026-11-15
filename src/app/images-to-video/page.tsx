"use client";

/**
 * صفحة "صور ← فيديو" — وضعان:
 *  1) «وصف نصي (مشاهد)» — الافتراضي: تكتب 4–8 أوصاف سطرًا لكل مشهد، وتولَّد الصور تلقائيًا من خدمة
 *     مجانية بلا مفتاح (Pollinations) ثم تتحرك بـ ffmpeg وتُدمج — بلا أي رفع أو API مدفوع.
 *     حد الخدمة المجانية ~صورة كل 45 ثانية لكل IP — تُدار تلقائيًا بانتظار وإعادة محاولة.
 *  2) «من صور مرفوعة» — رفع 4–8 صور مباشرة (كما كان).
 * التدفق من المتصفح مباشرة إلى خدمة الدمج (CORS مفتوح):
 *  إنشاء مهمة ← (توليد كل صورة للمشاهد) ← معالجة كل مشهد (مقطع 15 ثانية) ← دمج ← عرض + رابط تنزيل.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Film, ImagePlus, Loader2, MoveLeft, MoveRight, PenLine, RefreshCw, UploadCloud, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";

const MIN_SCENES = 4;
const MAX_SCENES = 8;
const MAX_IMAGE_MB = 15;

interface ImageItem {
  id: string;
  file: File;
  previewUrl: string;
}

interface SlideResult {
  videoUrl: string;
  downloadUrl: string;
  duration?: number;
  resolution?: string;
  sizeMB?: number;
}

type Phase = "idle" | "creating" | "uploading" | "processing" | "merging" | "done" | "error";
type Mode = "prompts" | "upload";

const phaseLabel: Record<Phase, string> = {
  idle: "بانتظار المدخلات",
  creating: "إنشاء المهمة…",
  uploading: "رفع الصور…",
  processing: "توليد الصور وتحريك المقاطع…",
  merging: "الدمج النهائي…",
  done: "اكتمل الفيديو",
  error: "حدث خطأ",
};

export default function ImagesToVideoPage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("prompts");
  const [promptsText, setPromptsText] = useState("");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [clipSeconds, setClipSeconds] = useState(15);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [stageText, setStageText] = useState("");
  const [result, setResult] = useState<SlideResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [mergerBase, setMergerBase] = useState<string>("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = phase === "creating" || phase === "uploading" || phase === "processing" || phase === "merging";

  const scenes = useMemo(
    () => promptsText.split("\n").map((s) => s.trim()).filter((s) => s.length > 0),
    [promptsText],
  );
  const scenesReady = scenes.length >= MIN_SCENES && scenes.length <= MAX_SCENES && scenes.every((s) => s.length >= 3);

  useEffect(() => {
    fetch("/api/slideshow-config", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { mergerBase?: string }) => setMergerBase(d.mergerBase ?? ""))
      .catch(() => setMergerBase(""))
      .finally(() => setConfigLoaded(true));
  }, []);

  // تحرير روابط المعاينة عند الخروج
  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchMode = (m: Mode) => {
    if (busy) return;
    setMode(m);
    setError(null);
  };

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      if (busy) return;
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      const rejected: string[] = [];
      setImages((prev) => {
        const next = [...prev];
        for (const f of list) {
          if (next.length >= MAX_SCENES) {
            rejected.push(`${f.name}: الحد الأقصى ${MAX_SCENES} صور`);
            continue;
          }
          if (f.size > MAX_IMAGE_MB * 1024 * 1024) {
            rejected.push(`${f.name}: أكبر من ${MAX_IMAGE_MB}MB`);
            continue;
          }
          next.push({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, file: f, previewUrl: URL.createObjectURL(f) });
        }
        return next;
      });
      if (rejected.length > 0) toast({ title: "بعض الملفات قُبلت وجزء رُفض", description: rejected.join(" • "), variant: "destructive" });
    },
    [busy, toast],
  );

  const removeImage = (id: string) => {
    if (busy) return;
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  };

  const moveImage = (id: string, dir: -1 | 1) => {
    if (busy) return;
    setImages((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
  };

  const reset = () => {
    if (busy) return;
    for (const img of images) URL.revokeObjectURL(img.previewUrl);
    setImages([]);
    setResult(null);
    setError(null);
    setProgress(0);
    setStageText("");
    setPhase("idle");
  };

  /** قراءة جسم خطأ عربي من خدمة الدمج (يدعم 429 مع retryAfter) */
  const serviceError = async (res: Response, fallback: string): Promise<{ message: string; retryAfter?: number }> => {
    try {
      const body = (await res.json()) as { error?: string; retryAfter?: number };
      return { message: body.error ?? fallback, retryAfter: body.retryAfter };
    } catch {
      return { message: fallback };
    }
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const start = async () => {
    if (busy) return;
    const usePrompts = mode === "prompts";
    if (usePrompts ? !scenesReady : images.length < MIN_SCENES || images.length > MAX_SCENES) return;
    setError(null);
    setResult(null);
    setProgress(0);
    try {
      if (!mergerBase) {
        setPhase("error");
        setError("خدمة الدمج غير مضبوطة على الخادم — اضبط MERGER_API_BASE في متغيرات البيئة ثم أعد المحاولة.");
        return;
      }

      /* 1) إنشاء المهمة */
      setPhase("creating");
      setStageText("إنشاء مهمة العرض الصوري…");
      const createBody = usePrompts
        ? { prompts: scenes, clip_seconds: clipSeconds }
        : {
            sources: images.map((img) => ({ kind: "file", name: img.file.name, size: img.file.size, mime: img.file.type })),
            clip_seconds: clipSeconds,
          };
      const createRes = await fetch(`${mergerBase}/api/slideshow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
      if (!createRes.ok) {
        setPhase("error");
        setError((await serviceError(createRes, "تعذر إنشاء مهمة العرض الصوري")).message);
        return;
      }
      const created = (await createRes.json()) as {
        jobId: string;
        uploadChunkBytes?: number;
        uploads?: Array<{ seq: number; uploadUrl: string }>;
      };

      /* 2) وضع الرفع: رفع الصور على أجزاء 4MB (0–39٪) */
      if (!usePrompts && created.uploads && created.uploadChunkBytes) {
        setPhase("uploading");
        const chunkBytes = created.uploadChunkBytes;
        const totalBytes = images.reduce((s, i) => s + i.file.size, 0);
        let uploadedBytes = 0;
        for (const img of images) {
          const seq = images.indexOf(img);
          const up = created.uploads.find((u) => u.seq === seq);
          if (!up) throw new Error(`لم يُرجع الخادم رابط رفع للصورة رقم ${seq + 1}`);
          const chunks = Math.ceil(img.file.size / chunkBytes);
          for (let k = 0; k < chunks; k++) {
            const blob = img.file.slice(k * chunkBytes, Math.min((k + 1) * chunkBytes, img.file.size));
            const res = await fetch(up.uploadUrl.replace("<k>", String(k)), { method: "POST", body: blob });
            if (!res.ok) {
              setPhase("error");
              setError((await serviceError(res, `فشل رفع جزء من الصورة "${img.file.name}"`)).message);
              return;
            }
            uploadedBytes += blob.size;
            setProgress(Math.min(39, Math.round((uploadedBytes / totalBytes) * 39)));
            setStageText(`رفع الصور… ${seq + 1}/${images.length}`);
          }
        }
      }

      /* 3) معالجة المشاهد: لكل مشهد — توليد الصورة (وضع النصوص) ثم التحريك والترميز (حتى 90٪) */
      setPhase("processing");
      const n = usePrompts ? scenes.length : images.length;
      for (let seq = 0; seq < n; seq++) {
        if (usePrompts) {
          setStageText(`توليد صورة المشهد ${seq + 1} من ${n} — خدمة مجانية بلا مفتاح (قد ينتظر حد ~45 ثانية)…`);
          setProgress((p) => Math.max(p, 8 + Math.round((seq * 30) / n)));
          // خطوة التوليد مع انتظار تلقائي عند استنزاف الحد المجاني (حتى 3 انتظارات لكل مشهد)
          let imageOk = false;
          for (let wait = 0; wait <= 3; wait++) {
            const res = await fetch(`${mergerBase}/api/slideshow/${created.jobId}/image?seq=${seq}`, { method: "POST" });
            if (res.ok) {
              imageOk = true;
              break;
            }
            const err = await serviceError(res, `فشل توليد صورة المشهد ${seq + 1}`);
            if (res.status === 429 && err.retryAfter && wait < 3) {
              const secs = Math.min(err.retryAfter + 1, 60);
              for (let t = secs; t > 0; t--) {
                setStageText(`حد الخدمة المجانية مستنزف — انتظار ${t} ثانية قبل توليد المشهد ${seq + 1}…`);
                await sleep(1_000);
              }
              continue;
            }
            setPhase("error");
            setError(err.message);
            return;
          }
          if (!imageOk) return;
        }
        setStageText(`معالجة المشهد ${seq + 1} من ${n} — تقريب وتحريك خفيف ${clipSeconds} ثانية…`);
        const res = await fetch(`${mergerBase}/api/slideshow/${created.jobId}/clip?seq=${seq}`, { method: "POST" });
        if (!res.ok) {
          setPhase("error");
          setError((await serviceError(res, `فشلت معالجة المشهد رقم ${seq + 1}`)).message);
          return;
        }
        const r = (await res.json()) as { progress?: number };
        setProgress(r.progress ?? 40 + Math.round(((seq + 1) * 50) / n));
      }

      /* 4) الدمج النهائي (90–100٪) */
      setPhase("merging");
      setStageText("دمج المقاطع في فيديو واحد…");
      setProgress(92);
      const mergeRes = await fetch(`${mergerBase}/api/slideshow/${created.jobId}/merge`, { method: "POST" });
      if (!mergeRes.ok) {
        setPhase("error");
        setError((await serviceError(mergeRes, "فشل الدمج النهائي")).message);
        return;
      }
      const merged = (await mergeRes.json()) as {
        videoUrl: string;
        downloadUrl: string;
        duration?: number;
        resolution?: string;
        size?: number;
      };
      setProgress(100);
      setPhase("done");
      setStageText("");
      setResult({
        videoUrl: merged.videoUrl,
        downloadUrl: merged.downloadUrl,
        duration: merged.duration,
        resolution: merged.resolution,
        sizeMB: merged.size ? merged.size / 1024 / 1024 : undefined,
      });
      toast({ title: "اكتمل الفيديو 🎉", description: `${n} مشاهد → فيديو رأسي ${merged.resolution ?? "720x1280"}` });
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "خطأ غير متوقع");
    }
  };

  const countBadge = useMemo(() => {
    if (mode === "prompts") {
      const n = scenes.length;
      if (n === 0) return { text: `اكتب ${MIN_SCENES} مشاهد على الأقل — سطر لكل مشهد`, cls: "border-zinc-600 bg-zinc-800/60 text-zinc-300" };
      if (n < MIN_SCENES) return { text: `أضف ${MIN_SCENES - n} مشاهد أخرى على الأقل`, cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" };
      if (n > MAX_SCENES) return { text: `الحد الأقصى ${MAX_SCENES} مشاهد`, cls: "border-rose-500/40 bg-rose-500/10 text-rose-300" };
      return { text: `${n} مشاهد — جاهز للتحويل`, cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" };
    }
    const n = images.length;
    if (n < MIN_SCENES) return { text: `أضف ${MIN_SCENES - n} صورة أخرى على الأقل`, cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" };
    if (n > MAX_SCENES) return { text: `الحد الأقصى ${MAX_SCENES} صور`, cls: "border-rose-500/40 bg-rose-500/10 text-rose-300" };
    return { text: `${n} صور — جاهز للتحويل`, cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" };
  }, [mode, scenes.length, images.length]);

  const canStart = mode === "prompts" ? scenesReady : images.length >= MIN_SCENES && images.length <= MAX_SCENES;

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800/80 bg-zinc-900/60 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-5xl px-4 py-4 flex flex-wrap items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <ArrowRight className="h-4 w-4" />
            لوحة الإدارة
          </Link>
          <div className="h-9 w-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <Film className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">تحويل الصور إلى فيديو</h1>
            <p className="text-xs text-zinc-400">
              أوصاف مشاهد نصية أو صور مرفوعة → فيديو واحد رأسي 9:16 بتحريك خفيف — بلا أي API مدفوع
            </p>
          </div>
          <Badge variant="outline" className="ms-auto border-zinc-700 text-zinc-300">
            Pollinations مجاني • ffmpeg • 720×1280 @ 24fps
          </Badge>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6 space-y-6">
        {/* بطاقة المدخلات */}
        <Card className="border-zinc-800 bg-zinc-900/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {mode === "prompts" ? <PenLine className="h-4 w-4 text-emerald-400" /> : <UploadCloud className="h-4 w-4 text-emerald-400" />}
              1) {mode === "prompts" ? "اكتب مشاهد الفيديو" : "اختر الصور"}
            </CardTitle>
            <CardDescription className="text-xs">
              {mode === "prompts"
                ? `سطر لكل مشهد بالترتيب — كل وصف يولَّد صورة من خدمة مجانية بلا مفتاح ثم يتحرك ${clipSeconds} ثانية.`
                : `رتّبها بالترتيب الذي تريده في الفيديو (تقديم/تأخير بأسهم التحريك) — كل صورة تصبح مقطع ${clipSeconds} ثانية.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            {/* تبويبات الوضع */}
            <div className="flex gap-2">
              <button
                onClick={() => switchMode("prompts")}
                disabled={busy}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                  mode === "prompts" ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                ✍️ من وصف نصي (مشاهد) — بدون رفع
              </button>
              <button
                onClick={() => switchMode("upload")}
                disabled={busy}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                  mode === "upload" ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                🖼️ من صور مرفوعة
              </button>
            </div>

            {mode === "prompts" ? (
              <div className="space-y-2">
                <textarea
                  value={promptsText}
                  onChange={(e) => setPromptsText(e.target.value)}
                  disabled={busy}
                  rows={8}
                  dir="rtl"
                  placeholder={
                    "مثال (سطر لكل مشهد):\nغروب شمس ذهبي على كثبان صحراء واسعة\nشارع مدينة قديم وقت المغرب بأضواء دافئة\nمقهى هادئ على رصيف حجري مع بخار قهوة\nبحر هادئ عند الفجر مع طيور نورس"
                  }
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950/70 p-3 text-sm text-zinc-100 leading-7 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none disabled:opacity-50"
                />
                <p className="text-[11px] text-zinc-500 leading-5">
                  كل صورة تُولَّد من خدمة Pollinations المجانية بلا مفتاح — حد الخدمة ~صورة كل 45 ثانية لكل IP، والانتظار وإعادة المحاولة تلقائيان. لو تعطّلت الخدمة كليًا ستظهر رسالة ببدائل واضحة.
                </p>
              </div>
            ) : (
              <>
                {/* منطقة السحب والإفلات */}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!busy) setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    if (!busy && e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
                  }}
                  onClick={() => !busy && fileInputRef.current?.click()}
                  className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
                    dragOver ? "border-emerald-500/60 bg-emerald-500/5" : "border-zinc-700 hover:border-zinc-500"
                  } ${busy ? "pointer-events-none opacity-50" : ""}`}
                >
                  <ImagePlus className="h-8 w-8 mx-auto text-zinc-500 mb-2" />
                  <p className="text-sm text-zinc-300 font-medium">اسحب الصور هنا أو اضغط للاختيار</p>
                  <p className="text-xs text-zinc-500 mt-1">JPG / PNG / WEBP / GIF / BMP — من {MIN_SCENES} إلى {MAX_SCENES} صور — حتى {MAX_IMAGE_MB}MB لكل صورة</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </div>

                {/* شبكة المعاينة */}
                {images.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {images.map((img, idx) => (
                      <div key={img.id} className="relative rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden group">
                        <div className="absolute top-1.5 start-1.5 z-10 h-6 w-6 rounded-full bg-emerald-500/90 text-zinc-950 text-xs font-bold flex items-center justify-center">
                          {idx + 1}
                        </div>
                        <button
                          onClick={() => removeImage(img.id)}
                          disabled={busy}
                          title="إزالة الصورة"
                          className="absolute top-1.5 end-1.5 z-10 h-6 w-6 rounded-full bg-zinc-950/80 text-zinc-300 hover:text-rose-300 flex items-center justify-center disabled:opacity-40"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                        {/* eslint-disable-next-line @next/next/no-img-element -- معاينة ملف محلي بـ objectURL */}
                        <img src={img.previewUrl} alt={img.file.name} className="h-32 w-full object-cover" />
                        <div className="px-2 py-1.5 flex items-center justify-between gap-1">
                          <span className="text-[10px] text-zinc-400 truncate" dir="ltr" title={img.file.name}>
                            {img.file.name}
                          </span>
                          <span className="flex items-center gap-0.5">
                            <button
                              onClick={() => moveImage(img.id, -1)}
                              disabled={busy || idx === 0}
                              title="تقديم في الترتيب"
                              className="p-1 rounded text-zinc-400 hover:text-emerald-300 disabled:opacity-30"
                            >
                              <MoveRight className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => moveImage(img.id, 1)}
                              disabled={busy || idx === images.length - 1}
                              title="تأخير في الترتيب"
                              className="p-1 rounded text-zinc-400 hover:text-emerald-300 disabled:opacity-30"
                            >
                              <MoveLeft className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* شريط العدد والمدة */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={countBadge.cls}>
                {countBadge.text}
              </Badge>
              <label className="flex items-center gap-2 text-xs text-zinc-400 ms-auto">
                مدة المقطع لكل {mode === "prompts" ? "مشهد" : "صورة"}:
                <select
                  value={clipSeconds}
                  disabled={busy}
                  onChange={(e) => setClipSeconds(Number(e.target.value))}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 disabled:opacity-50"
                >
                  {[5, 8, 10, 15, 20].map((s) => (
                    <option key={s} value={s}>
                      {s} ثانية
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* زر البدء */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={start}
                disabled={busy || !canStart || !configLoaded || !mergerBase}
                className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold gap-2"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
                إنشاء الفيديو ({mode === "prompts" ? `${scenes.length} مشاهد` : `${images.length} صور`} × {clipSeconds} ثانية)
              </Button>
              {((mode === "prompts" && promptsText.length > 0) || (mode === "upload" && images.length > 0) || result) && !busy && (
                <Button variant="ghost" onClick={reset} className="text-zinc-400 gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                  بدء عرض جديد
                </Button>
              )}
              {configLoaded && !mergerBase && (
                <span className="text-xs text-amber-300">
                  خدمة الدمج غير مضبوطة — اضبط MERGER_API_BASE ثم أعد تحميل الصفحة
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* بطاقة التقدم */}
        {busy || phase === "error" ? (
          <Card className="border-zinc-800 bg-zinc-900/70">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {busy ? <Loader2 className="h-4 w-4 animate-spin text-emerald-400" /> : <X className="h-4 w-4 text-rose-400" />}
                {phaseLabel[phase]}
              </CardTitle>
              {stageText ? <CardDescription className="text-xs">{stageText}</CardDescription> : null}
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Progress value={progress} className="h-2.5 flex-1" />
                <span className="text-xs text-zinc-400 tabular-nums w-10 text-center">{progress}%</span>
              </div>
              <p className="text-[11px] text-zinc-500 leading-5">
                {mode === "prompts"
                  ? "المراحل: توليد صورة كل مشهد من الوصف (خدمة مجانية — مع انتظار تلقائي عند الحد) ← تحريك كل صورة وترميز مقطعها ← الدمج النهائي. كل ذلك عبر ffmpeg وخدمة الدمج — بلا أي API مدفوع."
                  : "المراحل: رفع الصور (0–39٪) ← تحريك كل صورة وترميز مقطعها (40–90٪) ← الدمج النهائي (90–100٪)."}
              </p>
              {error ? (
                <p className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 leading-6 whitespace-pre-line">{error}</p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* بطاقة النتيجة */}
        {phase === "done" && result ? (
          <Card className="border-emerald-500/30 bg-zinc-900/70">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-emerald-300">
                <Film className="h-4 w-4" />
                الفيديو النهائي جاهز
              </CardTitle>
              <CardDescription className="text-xs">
                {result.resolution ?? "720x1280"} • {result.duration ? `${result.duration.toFixed(1)} ثانية` : ""}{" "}
                {result.sizeMB ? `• ${result.sizeMB.toFixed(1)}MB` : ""} — يُحذف من خدمة الدمج بعد ~24 ساعة، نزّله الآن.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="flex justify-center">
                <video
                  src={result.videoUrl}
                  controls
                  playsInline
                  className="rounded-xl border border-zinc-800 max-h-[65vh]"
                  style={{ maxWidth: "min(100%, 20rem)" }}
                />
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                <a href={result.downloadUrl} download>
                  <Button className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold gap-2">
                    <UploadCloud className="h-4 w-4" />
                    تنزيل الفيديو MP4
                  </Button>
                </a>
                <Button variant="ghost" onClick={reset} className="text-zinc-400 gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                  إنشاء عرض جديد
                </Button>
              </div>
              <p className="text-center text-[11px] text-zinc-500" dir="ltr">
                {result.videoUrl}
              </p>
            </CardContent>
          </Card>
        ) : null}

        {/* بطاقة شرح */}
        {phase === "idle" && (
          <Card className="border-zinc-800 bg-zinc-900/50">
            <CardHeader>
              <CardTitle className="text-sm">كيف تعمل؟</CardTitle>
            </CardHeader>
            <CardContent className="p-4 text-xs text-zinc-400 leading-6 space-y-1.5">
              <p>1. وضع «وصف نصي»: تكتب سطرًا لكل مشهد، وتُولَّد صورة كل مشهد تلقائيًا من خدمة Pollinations المجانية (بلا مفتاح، حد ~صورة كل 45 ثانية لكل IP مع انتظار تلقائي). وضع «صور مرفوعة»: ترفع صورك مباشرة.</p>
              <p>2. كل صورة تتحول عبر ffmpeg إلى مقطع {clipSeconds} ثانية رأسي 9:16 بتقريب/تحريك خفيف (Ken Burns) مع وهج دخول وخروج قصير.</p>
              <p>3. تُدمج المقاطع في فيديو MP4 واحد بلا إعادة ترميز (-c copy) — جودة عالية ودمج في ثوانٍ.</p>
              <p>4. تحصل على معاينة فورية ورابط تنزيل مباشر — والوظيفة نفسها متاحة لأي عميل MCP بأداة <code dir="ltr">images_to_video</code> مع prompts أو روابط أو مهام صور.</p>
            </CardContent>
          </Card>
        )}
      </main>

      <footer className="border-t border-zinc-800/80 mt-auto">
        <div className="mx-auto max-w-5xl px-4 py-3 text-xs text-zinc-500">
          ميزة العرض الصوري تعمل محليًا بـ ffmpeg داخل خدمة الدمج — وتوليد الصور من الأوصاف عبر خدمة مجانية بلا مفتاح — بلا أي API مدفوع.
        </div>
      </footer>
      <Toaster />
    </div>
  );
}
