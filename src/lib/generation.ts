/**
 * منسق التوليد — قلب المشروع (قسم 6 من المواصفة).
 * السياسات الجوهرية المنفذة هنا:
 * 1) ترتيب المفاتيح تسلسلي صارم بترتيب الإضافة — لا round-robin.
 * 2) تبديل تلقائي فوري عند أي خطأ مفتاح/رصيد — نفس المهمة تُستأنف بنفس task_id.
 * 3) فشل الإنشاء على كل المفاتيح → تبقى processing وتُعاد مع كل get_task بعد تهدئة ~45 ثانية.
 * 4) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا — كل ما يخرج للعميل عربي نظيف.
 * 5) لا يُنزَّل أي ملف وسائط — روابط فقط في قاعدة البيانات.
 */
import { classifyProviderError, isKeyRelatedFailure, ProviderError } from "@/lib/errors";
import { maskKey } from "@/lib/keys";
import {
  defaultModelFor,
  MERGE_MODEL,
  SLIDESHOW_MODEL,
  type ModelDef,
  normalizeModel,
  type MediaType,
} from "@/lib/models";
import { getAdapter, type ProviderInput } from "@/lib/providers";
import {
  createMergeJob,
  createSlideshowFromPrompts,
  createSlideshowJob,
  generateSlideshowImage,
  getMergeJob,
  getSlideshowJob,
  mergeSlideshow,
  processMergeJob,
  processSlideshowClip,
  MergerError,
  SlideshowImageStepResult,
  type SlideshowJobStatus,
} from "@/lib/merger";
import {
  bumpKeyCounters,
  getKeyPool,
  getTask,
  insertTask,
  updateKeyStatus,
  updateTask,
  type Attempt,
  type TaskRow,
} from "@/lib/turso";
import { randomUUID } from "node:crypto";

const POLL_INTERVAL_MS = 3_000; // استعلام كل 3 ثوانٍ أثناء نافذة الانتظار + بث التقدم
const RETRY_COOLDOWN_MS = 45_000; // تهدئة إعادة المحاولة بعد فشل الإنشاء على كل المفاتيح
const PROCESS_RESTART_MS = 180_000; // إن لم يكتمل process بعد 3 دقائق نسمح بإعادة إطلاقه

export interface ProgressNotify {
  (progress: number, total: number, message: string): void;
}

interface ToolArgs {
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function argsToProviderInput(args: ToolArgs): ProviderInput {
  return {
    prompt: args.prompt ?? "",
    imageUrl: args.image_url,
    aspectRatio: args.aspect_ratio,
    resolution: args.resolution,
    background: args.background,
    outputFormat: args.output_format,
    enableAudio: args.enable_audio,
    duration: args.duration,
  };
}

/** params_json = معطيات الطلب الأصلية (لإعادة الإنشاء عند التبديل) + حقول داخلية ببادئة _ */
function mergeParams(task: TaskRow, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(task.paramsJson) as Record<string, unknown>;
  } catch {
    base = {};
  }
  return JSON.stringify({ ...base, ...patch });
}

function internalParams(task: TaskRow): Record<string, unknown> {
  try {
    return JSON.parse(task.paramsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function attemptRecord(key: { id: string; provider: string; apiKey: string }, ok: boolean, errorClass: string, error: string): Attempt {
  return {
    provider: key.provider,
    keyId: key.id,
    keyLabel: maskKey(key.apiKey),
    ok,
    errorClass,
    error: error.slice(0, 300),
    at: new Date().toISOString(),
  };
}

interface CreationResult {
  ok: boolean;
  completedSync?: boolean; // صور متزامنة اكتملت فورًا
  paramsFail?: boolean; // خطأ معطيات — توقف فوري
  lastKeyId?: string;
}

/**
 * إنشاء المهمة لدى المزودين — يجرّب المرشحين بالترتيب الصارم حتى أول نجاح.
 * كل محاولة (نجاح أو فشل + فئتها) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 * afterKeyId: نستأنف من المفتاح التالي لهذا المعرّف (تبديل منتصف المهمة بنفس task_id).
 */
async function attemptCreation(
  taskId: string,
  model: ModelDef,
  type: MediaType,
  input: ProviderInput,
  afterKeyId?: string,
): Promise<CreationResult> {
  // نجلب المجموعة من جديد عند كل محاولة — المفاتيح المضافة حديثًا تدخل فورًا
  const pool = await getKeyPool(model.providers);
  let startIndex = 0;
  if (afterKeyId) {
    const idx = pool.findIndex((k) => k.id === afterKeyId);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }

  for (let i = startIndex; i < pool.length; i++) {
    const key = pool[i];
    const adapter = getAdapter(key.provider);
    const providerModel = model.providerModel[key.provider] ?? model.canonical;

    try {
      // صور CometAPI متزامنة: تُنشأ وتكتمل في النداء نفسه
      if (type === "image" && adapter.createImageSync && key.provider === "cometapi") {
        const { urls } = await adapter.createImageSync(key.apiKey, providerModel, input);
        await bumpKeyCounters(key.id, true);
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          provider: key.provider,
          providerTaskId: null,
          keyId: key.id,
          resultUrls: urls,
          errorMessage: null,
          appendAttempt: attemptRecord(key, true, "sync", "صورة متزامنة"),
        });
        return { ok: true, completedSync: true, lastKeyId: key.id };
      }

      const { providerTaskId } = await adapter.createTask(key.apiKey, providerModel, input, type === "image" ? "image" : "video");
      await bumpKeyCounters(key.id, true);
      await updateTask(taskId, {
        status: "processing",
        progress: 5,
        provider: key.provider,
        providerTaskId,
        keyId: key.id,
        errorMessage: null,
        appendAttempt: attemptRecord(key, true, "created", "أُنشئت المهمة لدى المزود"),
      });
      return { ok: true, lastKeyId: key.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cls = classifyProviderError(err);
      // سجل المحاولة + عدّادات المفتاح — دائمًا
      await bumpKeyCounters(key.id, false, msg);
      await updateTask(taskId, { appendAttempt: attemptRecord(key, false, cls, msg) });

      if (cls === "disabled") {
        await updateKeyStatus(key.id, "disabled", msg);
        continue; // الانتقال للمفتاح التالي
      }
      if (cls === "exhausted") {
        await updateKeyStatus(key.id, "exhausted", msg);
        continue; // يبقى في القاعدة دون عرقلة التالي
      }
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات (رسالة عربية نظيفة دون ذكر مفاتيح)
        await updateTask(taskId, {
          status: "failed",
          errorMessage: "فشلت المهمة: المعطيات المرسلة غير مقبولة من المزود — تحقق من الوصف أو المعاملات ثم أعد المحاولة.",
        });
        return { ok: false, paramsFail: true };
      }
      // provider / temporary → المفتاح التالي الآن
      continue;
    }
  }

  // فشل الإنشاء على كل المفاتيح → تبقى processing (وليست failed) بانتظار توفر مفتاح صالح
  await updateTask(taskId, {
    status: "processing",
    errorMessage: "بانتظار توفر مفتاح صالح… ستُعاد المحاولة تلقائيًا مع كل استدعاء get_task بعد تهدئة قصيرة.",
    paramsJson: mergeParams(await getTaskOrThrow(taskId), { _nextAttemptAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString() }),
  });
  return { ok: false };
}

async function getTaskOrThrow(taskId: string): Promise<TaskRow> {
  const t = await getTask(taskId);
  if (!t) throw new ProviderError(500, "المهمة اختفت من قاعدة البيانات");
  return t;
}

/** حلقة الانتظار: استعلام أول فوري ثم كل 3 ثوانٍ مع بث تقدم حي وتبديل منتصف المهمة عند فشل مفتاح/رصيد */
async function waitLoop(
  taskId: string,
  model: ModelDef,
  waitSeconds: number,
  notify: ProgressNotify | undefined,
  signal: AbortSignal | undefined,
  _startAfterKeyId?: string,
): Promise<TaskRow> {
  const deadline = Date.now() + waitSeconds * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) break;

    const task = await getTask(taskId);
    if (!task || task.status === "completed" || task.status === "failed") return task ?? (await getTaskOrThrow(taskId));
    if (!task.providerTaskId || !task.provider || !task.keyId) return task;

    const adapter = getAdapter(task.provider as "kie" | "cometapi");
    const providerModel = model.providerModel[task.provider as "kie" | "cometapi"] ?? model.canonical;

    // نحتاج مفتاح API النصي للاستعلام — نجيبه من القاعدة الحية (حتى المفاتيح المستنزفة تصلح للاستعلام)
    const poolAll = await getKeyPool(model.providers);
    const apiKey = poolAll.find((k) => k.id === task.keyId)?.apiKey;
    if (!apiKey) {
      // المفتاح حُذف أو عُطّل يدويًا أثناء المهمة → نعيد الإنشاء على المفاتيح السليمة بنفس task_id
      const created = await attemptCreation(taskId, model, task.type, argsToProviderInput(internalParams(task) as ToolArgs));
      if (created.ok) {
        const nt = await getTaskOrThrow(taskId);
        if (nt.status === "completed") return nt;
        continue;
      }
      return await getTaskOrThrow(taskId);
    }

    let check;
    try {
      check = await adapter.checkTask(apiKey, task.providerTaskId);
    } catch (err) {
      const cls = classifyProviderError(err);
      const msg = err instanceof Error ? err.message : String(err);
      await updateTask(taskId, {
        appendAttempt: attemptRecord({ id: task.keyId, provider: task.provider, apiKey }, false, cls, msg),
      });
      if (cls === "disabled" || cls === "exhausted") {
        await updateKeyStatus(task.keyId, cls, msg);
        // تبديل منتصف المهمة: نفس المهمة بنفس task_id على المفتاح التالي
        const created = await attemptCreation(taskId, model, task.type, argsToProviderInput(internalParams(task) as ToolArgs), task.keyId);
        if (created.ok) {
          const nt = await getTaskOrThrow(taskId);
          if (nt.status === "completed") return nt;
          continue;
        }
        return await getTaskOrThrow(taskId);
      }
      // temporary/provider أثناء الاستعلام → نستمر بالاستعلام دون تبديل
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (check.status === "completed" && check.urls) {
      await bumpKeyCounters(task.keyId, true);
      await updateTask(taskId, { status: "completed", progress: 100, resultUrls: check.urls, errorMessage: null });
      return await getTaskOrThrow(taskId);
    }
    if (check.status === "failed") {
      const failMsg = check.error ?? "فشل المزود دون رسالة";
      if (isKeyRelatedFailure(failMsg)) {
        // فشل منتصف المهمة بسبب مفتاح/رصيد → استئناف صامت بنفس task_id على المفتاح التالي
        const created = await attemptCreation(taskId, model, task.type, argsToProviderInput(internalParams(task) as ToolArgs), task.keyId);
        if (created.ok) {
          const nt = await getTaskOrThrow(taskId);
          if (nt.status === "completed") return nt;
          continue;
        }
        return await getTaskOrThrow(taskId);
      }
      // فشل حقيقي (انتهاك سياسة/معطيات) → فشل نهائي
      await updateTask(taskId, { status: "failed", errorMessage: `فشلت المهمة: ${failMsg.slice(0, 300)}` });
      return await getTaskOrThrow(taskId);
    }

    // جارية: نحدّث التقدم ونبثّ إشعارًا كل ~3 ثوانٍ
    const progress = Math.min(99, Math.max(task.progress, check.progress ?? task.progress));
    await updateTask(taskId, { progress });
    notify?.(progress, 100, `قيد التوليد… ${progress}%`);

    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // انتهت النافذة والنتيجة لم تظهر → المهمة تبقى processing والعميل يتابع بـ get_task
  return await getTaskOrThrow(taskId);
}

export interface RunResult {
  task: TaskRow;
  noKeys?: boolean;
  badModel?: boolean;
}

/**
 * التدفق الكامل لأداة generate_image / generate_video (قسم 6):
 * توحيد الموديل ← فحص المجموعة ← تسجيل المهمة قبل أي نداء خارجي ← إنشاء بالترتيب ← نافذة انتظار مع بث تقدم.
 */
export async function runGeneration(
  type: "image" | "video",
  args: ToolArgs,
  notify?: ProgressNotify,
  signal?: AbortSignal,
): Promise<RunResult> {
  // توحيد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري
  const model = args.model ? normalizeModel(args.model) : defaultModelFor(type);
  if (!model) {
    const ghost = { id: "-", status: "failed" as const, type, model: args.model, errorMessage: "موديل غير معروف" } as unknown as TaskRow;
    return { task: ghost, badModel: true };
  }

  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    const ghost = { id: "-", status: "pending" as const, type, model: model.canonical } as unknown as TaskRow;
    return { task: ghost, noKeys: true };
  }

  const taskId = randomUUID();
  const input = argsToProviderInput(args);
  // نسجّل المهمة في Turso قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  await insertTask({
    id: taskId,
    type,
    model: model.canonical,
    prompt: args.prompt ?? "",
    paramsJson: JSON.stringify(args),
    status: "pending",
  });

  const created = await attemptCreation(taskId, model, type, input);
  if (created.ok) {
    const waitSeconds = Math.min(240, Math.max(0, args.wait_seconds ?? (type === "image" ? 90 : 25)));
    const task = await waitLoop(taskId, model, waitSeconds, notify, signal, created.lastKeyId);
    return { task };
  }
  return { task: (await getTask(taskId))! };
}

/**
 * التدفق الكامل لأداة merge_videos (قسم 7.3).
 * تحقق صارم: ≥2 و≤10 وكلها http/https مباشرة — ثم تسجيل أولًا ثم إنشاء لدى الخدمة ثم إطلاق process مرة واحدة.
 */
export async function runMerge(
  args: { urls?: string[]; task_ids?: string[]; wait_seconds?: number },
  notify?: ProgressNotify,
  signal?: AbortSignal,
): Promise<RunResult> {
  const invalidTaskIds: string[] = [];
  const resolved: string[] = [];

  // روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها (قسم 8 من المواصفة)
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(tid);
    if (t && t.type === "video" && t.status === "completed" && t.resultUrls && t.resultUrls.length > 0) {
      resolved.push(...t.resultUrls);
    } else {
      invalidTaskIds.push(
        !t ? `${tid}: غير موجود` : t.status !== "completed" ? `${tid}: الحالة ${t.status} (يلزم مكتملة)` : `${tid}: بلا روابط نتائج`,
      );
    }
  }
  for (const u of args.urls ?? []) resolved.push(u);

  if (resolved.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (invalidTaskIds.length > 0) msg += "\n\nتفاصيل المعرفات غير الصالحة:\n- " + invalidTaskIds.join("\n- ");
    const ghost = { id: "-", status: "failed" as const, type: "merge", errorMessage: msg } as unknown as TaskRow;
    return { task: ghost };
  }
  if (resolved.length > 10) {
    const ghost = {
      id: "-",
      status: "failed" as const,
      type: "merge",
      errorMessage: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    } as unknown as TaskRow;
    return { task: ghost };
  }
  const badUrl = resolved.find((u) => !/^https?:\/\/\S+/.test(u));
  if (badUrl) {
    const ghost = {
      id: "-",
      status: "failed" as const,
      type: "merge",
      errorMessage: "❌ روابط الفيديو يجب أن تكون روابط مباشرة عامة (http/https).",
    } as unknown as TaskRow;
    return { task: ghost };
  }

  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    type: "merge",
    model: MERGE_MODEL,
    prompt: `دمج ${resolved.length} مقاطع`,
    paramsJson: JSON.stringify({ urls: resolved, wait_seconds: args.wait_seconds ?? 60 }),
    provider: "merger",
    status: "pending",
  });

  // إنشاء المهمة لدى خدمة الدمج
  try {
    const job = await createMergeJob(resolved);
    await updateTask(taskId, { status: "processing", provider: "merger", providerTaskId: job.jobId, progress: 5 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNetworkError = err instanceof MergerError ? err.status === 0 : false;
    if (isNetworkError) {
      // خطأ شبكتنا نحن → مؤقت: تبقى processing وتُعاد المحاولة مع get_task بعد التهدئة
      const current = await getTask(taskId);
      if (current) {
        await updateTask(taskId, {
          status: "processing",
          errorMessage: "تعذر الوصول إلى خدمة الدمج مؤقتًا — ستُعاد المحاولة تلقائيًا.",
          paramsJson: mergeParams(current, { _nextAttemptAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString() }),
        });
      }
      return { task: (await getTask(taskId))! };
    }
    // خطأ معلن من الخدمة (4xx/5xx) = فشل حتمي فوري — لا إعادة محاولة (قاعدة 7.3.5)
    await updateTask(taskId, { status: "failed", errorMessage: `فشل إنشاء مهمة الدمج: ${msg.slice(0, 300)}` });
    return { task: (await getTask(taskId))! };
  }

  // إطلاق process خلفيًا وبمرة واحدة فقط
  const task0 = (await getTask(taskId))!;
  await fireProcessOnce(task0, true);

  const waitSeconds = Math.min(240, Math.max(0, args.wait_seconds ?? 60));
  const task = await mergeWaitLoop(taskId, waitSeconds, notify, signal);
  return { task };
}

/** قفل الذاكرة processInFlight — يمنع تزامن process مع get_task */
const processInFlight = new Set<string>();

/* ===== العرض الصوري (صور ← فيديو رأسي 9:16 بتحريك خفيف — بلا أي API مدفوع) ===== */

// كل استدعاء get_task يقود خطوة معالجة بميزانية زمنية — يبقي الرد سريعًا ويتقدم العمل
const SLIDESHOW_STEP_BUDGET_MS = 45_000;

/** تقدم العرض الصوري: الإنشاء 0–5، المقاطع 40–90، الدمج 90–100 */
function slideshowProgress(readyCount: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, 40 + Math.round((readyCount / total) * 50)));
}

function isServiceDeclaredError(err: unknown): boolean {
  return err instanceof MergerError ? err.status !== 0 : false;
}

/**
 * قيادة مهمة العرض الصوري حتى سقف زمني: يعالج المقاطع الناقصة بالترتيب ثم يدمج.
 * أخطاء الخدمة المعلنة → فشل نهائي؛ أخطاء شبكتنا → تبقى processing وتُستأنف مع get_task.
 */
async function driveSlideshow(
  taskId: string,
  deadlineMs: number,
  notify?: ProgressNotify,
  signal?: AbortSignal,
): Promise<TaskRow> {
  for (;;) {
    if (signal?.aborted || Date.now() >= deadlineMs) break;
    const task = await getTaskOrThrow(taskId);
    if (task.status === "completed" || task.status === "failed") return task;
    const jobId = task.providerTaskId;
    if (!jobId) break;

    const params = internalParams(task);
    const images = (params.images as string[] | undefined) ?? [];
    const prompts = (params.prompts as string[] | undefined) ?? [];
    const clipSeconds = Number(params.clip_seconds) || 15;

    let st: SlideshowJobStatus;
    try {
      st = await getSlideshowJob(jobId);
    } catch (err) {
      if (isServiceDeclaredError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateTask(taskId, { status: "failed", errorMessage: `فشل العرض الصوري: ${msg.slice(0, 300)}` });
        return await getTaskOrThrow(taskId);
      }
      break; // خطأ شبكتنا نحن — ننتظر دورة قادمة
    }

    if (st.status === "done" && st.videoUrl) {
      await updateTask(taskId, { status: "completed", progress: 100, resultUrls: [st.videoUrl], errorMessage: null });
      return await getTaskOrThrow(taskId);
    }
    if (st.status === "failed") {
      await updateTask(taskId, { status: "failed", errorMessage: `فشل العرض الصوري: ${(st.error ?? "بدون رسالة").slice(0, 300)}` });
      return await getTaskOrThrow(taskId);
    }
    if (st.status === "missing") {
      // المهمة اختفت من الخدمة (تجاوزت 24 ساعة أو فُقدت) → إعادة إنشاء بعد تهدئة بنفس task_id
      const canRecreate = prompts.length >= 4 || images.length >= 4;
      const nextAt = params._nextAttemptAt ? Date.parse(String(params._nextAttemptAt)) : 0;
      if (Date.now() >= nextAt && canRecreate) {
        try {
          const job = prompts.length >= 4 ? await createSlideshowFromPrompts(prompts, clipSeconds) : await createSlideshowJob(images, clipSeconds);
          await updateTask(taskId, {
            providerTaskId: job.jobId,
            status: "processing",
            progress: 5,
            errorMessage: null,
            paramsJson: mergeParams(task, { _nextAttemptAt: undefined }),
          });
          continue;
        } catch (err) {
          if (isServiceDeclaredError(err)) {
            const msg = err instanceof Error ? err.message : String(err);
            await updateTask(taskId, { status: "failed", errorMessage: `فشل العرض الصوري: ${msg.slice(0, 300)}` });
            return await getTaskOrThrow(taskId);
          }
          await updateTask(taskId, { paramsJson: mergeParams(task, { _nextAttemptAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString() }) });
          break;
        }
      }
      break;
    }

    const missing = st.clips.filter((c) => !c.ready).map((c) => c.seq).sort((a, b) => a - b);
    const baseProgress = Math.max(task.progress, slideshowProgress(st.clipsReady, st.imageCount));

    if (missing.length === 0) {
      // كل المقاطع جاهزة → الدمج النهائي (-c copy سريع)
      notify?.(Math.max(baseProgress, 90), 100, `دمج ${st.imageCount} مقاطع في فيديو واحد…`);
      try {
        const merged = await mergeSlideshow(jobId);
        const urls = merged.downloadUrl && merged.downloadUrl !== merged.videoUrl ? [merged.videoUrl, merged.downloadUrl] : [merged.videoUrl];
        await updateTask(taskId, { status: "completed", progress: 100, resultUrls: urls, errorMessage: null });
        return await getTaskOrThrow(taskId);
      } catch (err) {
        if (isServiceDeclaredError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          await updateTask(taskId, { status: "failed", errorMessage: `فشل العرض الصوري: ${msg.slice(0, 300)}` });
          return await getTaskOrThrow(taskId);
        }
        break;
      }
    }

    // معالجة المشهد الناقص التالية بالترتيب: توليد الصورة أولًا لمشاهد prompts ثم التحريك والترميز
    const seq = missing[0];
    const clipState = st.clips.find((c) => c.seq === seq);
    if (clipState?.kind === "prompt" && !clipState.imageReady) {
      notify?.(baseProgress, 100, `توليد صورة المشهد ${seq + 1} من ${st.imageCount} (خدمة صور مجانية بلا مفتاح)…`);
      const img = await generateSlideshowImage(jobId, seq);
      if (img.state === "networkError") break; // شبكتنا نحو خدمة الدمج — تُستأنف مع get_task
      if (img.state === "mergerError") {
        await updateTask(taskId, { status: "failed", errorMessage: `فشل العرض الصوري: ${img.message.slice(0, 300)}` });
        return await getTaskOrThrow(taskId);
      }
      if (img.state === "rateLimited") {
        // حد الخدمة المجانية (~صورة كل 45 ثانية لكل IP): ننتظر داخل نافذة الانتظار ثم نعيد نفس المشهد
        const waitMs = Math.min(img.retryAfter * 1000 + 1_000, Math.max(0, deadlineMs - Date.now()));
        if (waitMs > 2_000) {
          notify?.(baseProgress, 100, `انتظار حد الخدمة المجانية لتوليد الصور (~${Math.round(waitMs / 1000)} ثانية)…`);
          await sleep(waitMs);
          continue; // دورة جديدة على نفس المشهد (الرابط حتمي — قد يعاد من الذاكرة المؤقتة)
        }
        break; // انتهت نافذة الانتظار — تبقى processing وتُستأنف مع get_task
      }
      if (img.state === "serviceDown") {
        // خدمة التوليد المجانية غير متاحة — المهمة تبقى processing وتُستأنف تلقائيًا مع get_task
        await updateTask(taskId, { status: "processing", errorMessage: img.message.slice(0, 300) });
        break;
      }
    }
    notify?.(baseProgress, 100, `معالجة المشهد ${seq + 1} من ${st.imageCount} — مقطع ${st.clipSeconds} ثانية رأسي 9:16…`);
    try {
      await processSlideshowClip(jobId, seq);
      const st2 = await getSlideshowJob(jobId);
      await updateTask(taskId, {
        status: "processing",
        progress: Math.max(baseProgress, slideshowProgress(st2.clipsReady, st2.imageCount)),
      });
    } catch (err) {
      if (isServiceDeclaredError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateTask(taskId, { status: "failed", errorMessage: `فشل العرض الصوري: ${msg.slice(0, 300)}` });
        return await getTaskOrThrow(taskId);
      }
      break; // شبكتنا — تُستأنف الصورة نفسها في الدورة القادمة (clip قابل لإعادة التنفيذ)
    }
  }
  return await getTaskOrThrow(taskId);
}

/**
 * التدفق الكامل لأداة images_to_video — تحويل 4 إلى 8 مشاهد/صور إلى فيديو واحد رأسي 9:16 (مقطع 15 ثانية لكل مشهد
 * بتحريك خفيف + دمج نهائي) عبر خدمة الدمج المحلية بلا أي API مدفوع.
 * ثلاثة مداخل بالأولوية: prompts (أوصاف مشاهد تُولَّد صورها من خدمة مجانية بلا مفتاح — Pollinations)
 * ثم images (روابط مباشرة) ثم task_ids (مهام صور مكتملة تُحل روابطها من قاعدة البيانات).
 */
export async function runImagesToVideo(
  args: { prompts?: string[]; images?: string[]; task_ids?: string[]; clip_seconds?: number; wait_seconds?: number },
  notify?: ProgressNotify,
  signal?: AbortSignal,
): Promise<RunResult> {
  const invalidTaskIds: string[] = [];
  const resolved: string[] = [];

  const ghostFail = (msg: string): RunResult => ({
    task: { id: "-", status: "failed", type: "slideshow", errorMessage: msg } as unknown as TaskRow,
  });

  // وضع "مشاهد نصية": prompts تتفرد (أولوية قصوى) ولا تُقبل مع images/task_ids معًا
  const promptsRaw = (args.prompts ?? []).map((p) => String(p ?? "").trim()).filter((p) => p.length > 0);
  const prompts = [...new Set(promptsRaw)];
  const wantsMedia = Array.isArray(args.images) || Array.isArray(args.task_ids);
  if (prompts.length > 0 && wantsMedia) {
    return ghostFail("❌ مرر prompts (أوصاف مشاهد) أو images/task_ids (صور جاهزة) — ليس الاثنين معًا.");
  }

  let clipSeconds = 15;
  if (args.clip_seconds !== undefined) {
    const cs = Number(args.clip_seconds);
    if (!Number.isFinite(cs) || cs < 5 || cs > 20) {
      return ghostFail("❌ clip_seconds يجب أن يكون بين 5 و 20 ثانية لكل صورة.");
    }
    clipSeconds = Math.round(cs);
  }

  if (prompts.length > 0) {
    if (prompts.length < 4) {
      return ghostFail("❌ العرض الصوري يحتاج 4 مشاهد على الأقل — سطر/عنصر لكل مشهد. مررت " + prompts.length + ".");
    }
    if (prompts.length > 8) {
      return ghostFail("❌ أقصى عدد مشاهد للعرض الصوري هو 8 — خفّض القائمة وأعد المحاولة.");
    }
    const short = prompts.find((p) => p.length < 3 || p.length > 600);
    if (short) {
      return ghostFail("❌ كل وصف مشهد يجب أن يكون نصًا بين 3 و 600 حرف.");
    }
    return runImagesToVideoFromPrompts(prompts, clipSeconds, args.wait_seconds, notify, signal, ghostFail);
  }

  // روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها — نفس نمط merge_videos
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(tid);
    if (t && t.type === "image" && t.status === "completed" && t.resultUrls && t.resultUrls.length > 0) {
      resolved.push(...t.resultUrls);
    } else {
      invalidTaskIds.push(
        !t ? `${tid}: غير موجود` : t.status !== "completed" ? `${tid}: الحالة ${t.status} (يلزم مكتملة)` : `${tid}: بلا روابط نتائج`,
      );
    }
  }
  for (const u of args.images ?? []) resolved.push(String(u).trim());
  const images = [...new Set(resolved.filter((u) => u.length > 0))];

  if (images.length < 4) {
    let msg = "❌ العرض الصوري يحتاج 4 مشاهد/صور على الأقل. مرّر prompts (وصف نصي لكل مشهد) أو images (روابط صور مباشرة) أو task_ids لمهام صور مكتملة.";
    if (invalidTaskIds.length > 0) msg += "\n\nتفاصيل المعرفات غير الصالحة:\n- " + invalidTaskIds.join("\n- ");
    return ghostFail(msg);
  }
  if (images.length > 8) {
    return ghostFail("❌ أقصى عدد صور للعرض الصوري هو 8 — خفّض القائمة وأعد المحاولة.");
  }
  const badUrl = images.find((u) => !/^https?:\/\/\S+/.test(u));
  if (badUrl) {
    return ghostFail("❌ روابط الصور يجب أن تكون روابط مباشرة عامة (http/https).");
  }

  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    type: "slideshow",
    model: SLIDESHOW_MODEL,
    prompt: `عرض صوري من ${images.length} صور — مقاطع ${clipSeconds} ثانية رأسي 9:16 بتحريك خفيف`,
    paramsJson: JSON.stringify({ images, clip_seconds: clipSeconds, wait_seconds: args.wait_seconds ?? 240 }),
    provider: "merger",
    status: "pending",
  });

  try {
    const job = await createSlideshowJob(images, clipSeconds);
    await updateTask(taskId, { status: "processing", provider: "merger", providerTaskId: job.jobId, progress: 5 });
  } catch (err) {
    if (isServiceDeclaredError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateTask(taskId, { status: "failed", errorMessage: `فشل إنشاء مهمة العرض الصوري: ${msg.slice(0, 300)}` });
    } else {
      // شبكتنا → مؤقت: تُعاد المحاولة مع get_task بعد التهدئة
      const current = await getTask(taskId);
      if (current) {
        await updateTask(taskId, {
          errorMessage: "تعذر الوصول إلى خدمة الدمج مؤقتًا — ستُعاد المحاولة تلقائيًا.",
          paramsJson: mergeParams(current, { _nextAttemptAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString() }),
        });
      }
    }
    return { task: (await getTask(taskId))! };
  }

  const waitSeconds = Math.min(240, Math.max(0, args.wait_seconds ?? 240));
  const task = await driveSlideshow(taskId, Date.now() + waitSeconds * 1000, notify, signal);
  return { task };
}

/** رسالة البديل الواضحة عندما تكون خدمة توليد الصور المجانية غير متاحة (بلا بادئة ❌ — صياغة formatFailed تضيفها) */
function freeImagegenFallbackMessage(detail: string): string {
  return (
    `خدمة توليد الصور المجانية (Pollinations) غير متاحة الآن — ${detail}\n\n` +
    "البديل (اختر واحدًا):\n" +
    "1) أعد المحاولة بعد دقيقة تقريبًا — الحد المجاني ~صورة كل 45 ثانية لكل IP وقد يكون مستنزفًا مؤقتًا من مستخدمي نفس عنوان الخروج.\n" +
    "2) ولّد الصور بنفسك بأداة generate_image (مفتاحك الحالي) ثم مررها إلى images_to_video عبر task_ids (مهام الصور المكتملة) أو images (روابط مباشرة).\n" +
    "3) مرر images بأي روابط صور مباشرة عامة تملكها."
  );
}

/** تدفق وضع المشاهد النصية: إنشاء مهمة prompts + فحص مسبق لتوليد أول مشهد + قيادة كاملة */
async function runImagesToVideoFromPrompts(
  prompts: string[],
  clipSeconds: number,
  waitSecondsArg: number | undefined,
  notify: ProgressNotify | undefined,
  signal: AbortSignal | undefined,
  ghostFail: (msg: string) => RunResult,
): Promise<RunResult> {
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    type: "slideshow",
    model: SLIDESHOW_MODEL,
    prompt: `فيديو من ${prompts.length} مشاهد وصفية — مقاطع ${clipSeconds} ثانية رأسي 9:16 بتحريك خفيف (توليد صور مجاني بلا مفتاح)`,
    paramsJson: JSON.stringify({ prompts, clip_seconds: clipSeconds, wait_seconds: waitSecondsArg ?? 240 }),
    provider: "merger",
    status: "pending",
  });

  let jobId: string;
  try {
    const job = await createSlideshowFromPrompts(prompts, clipSeconds);
    jobId = job.jobId;
    await updateTask(taskId, { status: "processing", provider: "merger", providerTaskId: jobId, progress: 5 });
  } catch (err) {
    if (isServiceDeclaredError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateTask(taskId, { status: "failed", errorMessage: `فشل إنشاء مهمة العرض الصوري: ${msg.slice(0, 300)}` });
    } else {
      const current = await getTask(taskId);
      if (current) {
        await updateTask(taskId, {
          errorMessage: "تعذر الوصول إلى خدمة الدمج مؤقتًا — ستُعاد المحاولة تلقائيًا.",
          paramsJson: mergeParams(current, { _nextAttemptAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString() }),
        });
      }
    }
    return { task: (await getTask(taskId))! };
  }

  // فحص مسبق: أول مشهد يولَّد فورًا — إن ظل حد الخدمة المجانية مستنزفًا رغم الانتظار الداخلي
  // نحاول مرة أخيرة بانتظار محدود ثم نفشل سريعًا برسالة البديل الواضحة (بدل انتظار طويل بلا جدوى)
  notify?.(5, 100, "توليد صورة المشهد الأول (خدمة صور مجانية بلا مفتاح)…");
  const preflightDeadline = Date.now() + 110_000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) break;
    const img = await generateSlideshowImage(jobId, 0);
    if (img.state === "networkError") {
      return { task: (await getTask(taskId))! }; // شبكتنا نحو خدمة الدمج — تُستأنف مع get_task
    }
    if (img.state === "mergerError") {
      await updateTask(taskId, { status: "failed", errorMessage: `فشل العرض الصوري: ${img.message.slice(0, 300)}` });
      return { task: (await getTask(taskId))! };
    }
    if (img.state === "ok") break;
    if (img.state === "serviceDown") {
      await updateTask(taskId, { status: "failed", errorMessage: freeImagegenFallbackMessage(img.message.slice(0, 200)) });
      return { task: (await getTask(taskId))! };
    }
    // rateLimited: انتظار محدود ثم محاولة أخيرة
    if (attempt < 2) {
      const waitMs = Math.min(img.retryAfter * 1000 + 1_000, Math.max(0, preflightDeadline - Date.now()));
      if (waitMs > 2_000) {
        notify?.(5, 100, `حد الخدمة المجانية مستنزف — انتظار ~${Math.round(waitMs / 1000)} ثانية ثم إعادة المحاولة…`);
        await sleep(waitMs);
        continue;
      }
    }
    await updateTask(taskId, {
      status: "failed",
      errorMessage: freeImagegenFallbackMessage("ظل حد الصورة كل ~45 ثانية لكل IP مستنزفًا رغم الانتظار (بذرة المشهد الأول محفوظة — الإعادة سريعة)"),
    });
    return { task: (await getTask(taskId))! };
  }

  const waitSeconds = Math.min(240, Math.max(0, waitSecondsArg ?? 240));
  const task = await driveSlideshow(taskId, Date.now() + waitSeconds * 1000, notify, signal);
  return { task };
}

/** تحديث مهمة عرض صوري جارية من الخدمة — يُستدعى من get_task ويعالج خطوة واحدة على الأقل */
async function refreshSlideshowTask(task: TaskRow): Promise<TaskRow> {
  if (!task.providerTaskId) {
    // لم تُنشأ لدى الخدمة أصلًا (فشل شبكة عند الإنشاء) → إعادة إنشاء بعد التهدئة
    const params = internalParams(task);
    const nextAt = params._nextAttemptAt ? Date.parse(String(params._nextAttemptAt)) : 0;
    if (Date.now() < nextAt) return task;
    const prompts = (params.prompts as string[] | undefined) ?? [];
    const images = (params.images as string[] | undefined) ?? [];
    const clipSeconds = Number(params.clip_seconds) || 15;
    const canRecreate = prompts.length >= 4 || images.length >= 4;
    if (!canRecreate) return task;
    try {
      const job = prompts.length >= 4 ? await createSlideshowFromPrompts(prompts, clipSeconds) : await createSlideshowJob(images, clipSeconds);
      await updateTask(task.id, { status: "processing", provider: "merger", providerTaskId: job.jobId, progress: 5, errorMessage: null });
    } catch (err) {
      if (isServiceDeclaredError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateTask(task.id, { status: "failed", errorMessage: `فشل العرض الصوري: ${msg.slice(0, 300)}` });
      } else {
        await updateTask(task.id, { paramsJson: mergeParams(task, { _nextAttemptAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString() }) });
      }
      return (await getTask(task.id))!;
    }
  }
  return driveSlideshow(task.id, Date.now() + SLIDESHOW_STEP_BUDGET_MS);
}

async function fireProcessOnce(task: TaskRow, force = false): Promise<void> {
  if (!task.providerTaskId) return;
  if (processInFlight.has(task.id) && !force) return;
  const params = internalParams(task);
  const startedAt = params._processStartedAt ? Date.parse(String(params._processStartedAt)) : 0;
  if (!force && startedAt && Date.now() - startedAt < PROCESS_RESTART_MS) return;

  processInFlight.add(task.id);
  await updateTask(task.id, { paramsJson: mergeParams(task, { _processStartedAt: new Date().toISOString() }) });
  // إطلاق خلفي — لا ينتظر أحد نتيجته في مسار الطلب؛ الاستعلام GET هو مصدر الحقيقة
  void processMergeJob(task.providerTaskId)
    .catch(() => {
      /* يُلتقط الفشل النهائي من GET /api/jobs/{id} في حلقة الاستعلام */
    })
    .finally(() => {
      setTimeout(() => processInFlight.delete(task.id), 5_000);
    });
}

/** حلقة انتظار الدمج: استعلام GET كل 3 ثوانٍ، أخطاء الخدمة المعلنة حتمية وأخطاء شبكتنا مؤقتة */
async function mergeWaitLoop(taskId: string, waitSeconds: number, notify?: ProgressNotify, signal?: AbortSignal): Promise<TaskRow> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    await sleep(POLL_INTERVAL_MS);
    if (signal?.aborted) break;

    const task = await getTask(taskId);
    if (!task || task.status === "completed" || task.status === "failed") return task ?? (await getTaskOrThrow(taskId));
    if (!task.providerTaskId) return task;

    let st;
    try {
      st = await getMergeJob(task.providerTaskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isServiceError = err instanceof MergerError ? err.status !== 0 : false;
      if (isServiceError) {
        // خطأ HTTP معلن من الخدمة = فشل نهائي فوري (قاعدة 7.3.5)
        await updateTask(taskId, { status: "failed", errorMessage: `فشل الدمج: ${msg.slice(0, 300)}` });
        return await getTaskOrThrow(taskId);
      }
      // خطأ شبكتنا → مؤقت: نستمر بالاستعلام حتى نهاية النافذة
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (st.state === "completed" && st.videoUrl) {
      await updateTask(taskId, { status: "completed", progress: 100, resultUrls: [st.videoUrl], errorMessage: null });
      return await getTaskOrThrow(taskId);
    }
    if (st.state === "failed") {
      await updateTask(taskId, { status: "failed", errorMessage: `فشل الدمج: ${(st.error ?? "بدون رسالة").slice(0, 300)}` });
      return await getTaskOrThrow(taskId);
    }

    const progress = Math.min(99, Math.max(task.progress, Math.round(st.progress)));
    await updateTask(taskId, { progress, status: "processing" });
    notify?.(progress, 100, `قيد الدمج… ${progress}%`);
  }
  return await getTaskOrThrow(taskId);
}

/** تحديث مهمة دمج جارية من الخدمة (قسم 7.3.6) — يُستدعى من get_task */
async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  if (!task.providerTaskId) {
    // لم تُنشأ لدى الخدمة أصلًا (فشل شبكة عند الإنشاء) → إعادة إنشاء بعد التهدئة
    const params = internalParams(task);
    const nextAt = params._nextAttemptAt ? Date.parse(String(params._nextAttemptAt)) : 0;
    if (Date.now() < nextAt) return task;
    const urls = (params.urls as string[] | undefined) ?? [];
    if (urls.length < 2) return task;
    try {
      const job = await createMergeJob(urls);
      await updateTask(task.id, { status: "processing", provider: "merger", providerTaskId: job.jobId, progress: 5, errorMessage: null });
      const fresh = (await getTask(task.id))!;
      await fireProcessOnce(fresh, true);
      return (await getTask(task.id))!;
    } catch {
      await updateTask(task.id, {
        paramsJson: mergeParams(task, { _nextAttemptAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString() }),
      });
      return task;
    }
  }

  let st;
  try {
    st = await getMergeJob(task.providerTaskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isServiceError = err instanceof MergerError ? err.status !== 0 : false;
    if (isServiceError) {
      await updateTask(task.id, { status: "failed", errorMessage: `فشل الدمج: ${msg.slice(0, 300)}` });
      return (await getTask(task.id))!;
    }
    return task; // شبكتنا — نرجع الحالة الحالية
  }

  if (st.state === "completed" && st.videoUrl) {
    await updateTask(task.id, { status: "completed", progress: 100, resultUrls: [st.videoUrl], errorMessage: null });
    return (await getTask(task.id))!;
  }
  if (st.state === "failed") {
    await updateTask(task.id, { status: "failed", errorMessage: `فشل الدمج: ${(st.error ?? "بدون رسالة").slice(0, 300)}` });
    return (await getTask(task.id))!;
  }

  // جارية: إن لم يُنفَّذ process بعد فنفّذه الآن (دفاعيًا)
  await fireProcessOnce(task);
  const progress = Math.min(99, Math.max(task.progress, Math.round(st.progress)));
  await updateTask(task.id, { progress, status: "processing" });
  return (await getTask(task.id))!;
}

/**
 * refreshTask — يُستدعى من get_task: المهمة الجارية تُحدَّث حية من المزود/الخدمة
 * مع نفس منطق إعادة المحاولة/التبديل، ثم تُصاغ عربيًا للعرض.
 */
export async function refreshTask(taskId: string, notify?: ProgressNotify, signal?: AbortSignal): Promise<RunResult> {
  const task = await getTask(taskId);
  if (!task) {
    const ghost = {
      id: taskId,
      status: "failed" as const,
      type: "image" as const,
      model: "-",
      errorMessage: `لم يتم العثور على مهمة بالمعرف ${taskId}`,
    } as unknown as TaskRow;
    return { task: ghost };
  }

  if (task.status === "completed" || task.status === "failed") return { task };

  if (task.type === "merge") return { task: await refreshMergeTask(task) };
  if (task.type === "slideshow") return { task: await refreshSlideshowTask(task) };

  // صور/فيديو
  if (task.providerTaskId && task.provider) {
    // جارية لدى المزود — نستخدم حلقة الانتظار الافتراضية القصيرة (استعلام واحد تقريبًا)
    const model = normalizeModel(task.model) ?? defaultModelFor(task.type);
    return { task: await waitLoop(task.id, model, 3, notify, signal, task.keyId ?? undefined) };
  }

  // لا يوجد providerTaskId → لم ينجح الإنشاء بعد: إعادة المحاولة بعد التهدئة (قاعدة 4.3.3)
  const params = internalParams(task);
  const nextAt = params._nextAttemptAt ? Date.parse(String(params._nextAttemptAt)) : 0;
  if (Date.now() < nextAt) return { task };

  const model = normalizeModel(task.model) ?? defaultModelFor(task.type);
  await attemptCreation(task.id, model, task.type, argsToProviderInput(params as ToolArgs));
  const fresh = (await getTask(task.id))!;
  if (fresh.providerTaskId) {
    return { task: await waitLoop(task.id, model, 20, notify, signal, fresh.keyId ?? undefined) };
  }
  return { task: fresh };
}
