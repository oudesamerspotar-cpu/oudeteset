/**
 * طبقة Turso — عميل واحد عبر HTTP (نسخة web من @libsql/client) للتوافق الكامل مع Vercel serverless:
 * لا ملفات SQLite محلية ولا اتصالات socket — كل شيء عبر HTTPS.
 * المخطط يُنشأ عند أول وصول بـ CREATE TABLE IF NOT EXISTS فلا حاجة لأداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client/web";

export interface Attempt {
  provider: string;
  keyId: string;
  keyLabel: string; // مُقنَّع دائمًا (maskKey)
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type TaskType = "image" | "video" | "merge";

export interface TaskRow {
  id: string;
  provider: string | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  paramsJson: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[] | null;
  errorMessage: string | null;
  attempts: Attempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  apiKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const nowIso = (): string => new Date().toISOString();

/* عميل واحد بطيء الإنشاء — لا يُرمى خطأ عند البناء إن غابت المتغيرات، بل عند أول استخدام */
let _client: Client | null = null;
function getDb(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = buildSchema();
    // عند فشل عابر نسمح بإعادة المحاولة في الطلب التالي
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  return schemaReady;
}

async function buildSchema(): Promise<void> {
  const db = getDb();
  await db.batch(
      [
        {
          sql: `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT,
            updated_at TEXT,
            completed_at TEXT
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT
          )`,
          args: [],
        },
        /* فهارس مساندة: ترتيب المفاتيح التسلسلي الصارم والاستعلامات الحديثة */
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_keys_order ON api_keys (provider, created_at, id)`,
          args: [],
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_tasks_recent ON tasks (created_at)`,
          args: [],
        },
      ],
      "write",
    );
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/* ===== المهام ===== */

function rowToTask(r: Record<string, unknown>): TaskRow {
  const parseJson = <T,>(s: unknown, fallback: T): T => {
    if (typeof s !== "string" || !s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    providerTaskId: (r.provider_task_id as string) ?? null,
    keyId: (r.key_id as string) ?? null,
    model: String(r.model ?? ""),
    type: (r.type as TaskType) ?? "image",
    prompt: String(r.prompt ?? ""),
    paramsJson: String(r.params_json ?? "{}"),
    status: (r.status as TaskStatus) ?? "pending",
    progress: Number(r.progress ?? 0),
    resultUrls: parseJson<string[] | null>(r.result_urls_json, null),
    errorMessage: (r.error_message as string) ?? null,
    attempts: parseJson<Attempt[]>(r.attempts_json, []),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    completedAt: (r.completed_at as string) ?? null,
  };
}

const taskCols = `id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json, created_at, updated_at, completed_at`;

export async function insertTask(t: {
  id: string;
  type: TaskType;
  model: string;
  prompt: string;
  paramsJson: string;
  provider?: string | null;
  status?: TaskStatus;
}): Promise<void> {
  await ensureSchema();
  const at = nowIso();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress, attempts_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?)`,
    args: [t.id, t.provider ?? null, t.model, t.type, t.prompt, t.paramsJson, t.status ?? "pending", at, at],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await getDb().execute({ sql: `SELECT ${taskCols} FROM tasks WHERE id = ?`, args: [id] });
  if (res.rows.length === 0) return null;
  return rowToTask(res.rows[0] as unknown as Record<string, unknown>);
}

/** تحديث جزئي (patch) — يضيف محاولات ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(
  id: string,
  patch: {
    status?: TaskStatus;
    progress?: number;
    provider?: string;
    providerTaskId?: string | null;
    keyId?: string | null;
    resultUrls?: string[] | null;
    errorMessage?: string | null;
    appendAttempt?: Attempt;
    paramsJson?: string;
  },
): Promise<void> {
  await ensureSchema();
  // نقرأ الحالي لإلحاق المحاولات وتوحيد completed_at — عمليات المفاتيح غير متزامنة لكن كل مهمة تُحدَّث من مسار واحد
  const current = await getTask(id);
  if (!current) return;
  const attempts = current.attempts;
  if (patch.appendAttempt) attempts.push(patch.appendAttempt);

  const status = patch.status ?? current.status;
  const completedAt =
    status === "completed" ? current.completedAt ?? nowIso() : status === "failed" ? current.completedAt ?? nowIso() : null;

  await getDb().execute({
    sql: `UPDATE tasks SET
            status = ?, progress = ?, provider = ?, provider_task_id = ?, key_id = ?,
            result_urls_json = ?, error_message = ?, attempts_json = ?, params_json = ?,
            completed_at = ?, updated_at = ?
          WHERE id = ?`,
    args: [
      status,
      patch.progress ?? current.progress,
      patch.provider ?? current.provider,
      patch.providerTaskId !== undefined ? patch.providerTaskId : current.providerTaskId,
      patch.keyId !== undefined ? patch.keyId : current.keyId,
      patch.resultUrls !== undefined ? JSON.stringify(patch.resultUrls) : current.resultUrls ? JSON.stringify(current.resultUrls) : null,
      patch.errorMessage !== undefined ? patch.errorMessage : current.errorMessage,
      JSON.stringify(attempts),
      patch.paramsJson ?? current.paramsJson,
      completedAt,
      nowIso(),
      id,
    ],
  });
}

export async function listRecentTasks(
  limit: number,
  filter: { type?: string; status?: string } = {},
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const sql = `SELECT ${taskCols} FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const res = await getDb().execute({ sql, args });
  return res.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const res = await getDb().execute({
    sql: `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END), 0) AS processing
          FROM tasks`,
    args: [],
  });
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    processing: Number(r.processing ?? 0),
  };
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] });
}

/* ===== المفاتيح ===== */

function rowToKey(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id),
    provider: r.provider as KeyRow["provider"],
    label: String(r.label ?? ""),
    apiKey: String(r.api_key),
    status: (r.status as KeyRow["status"]) ?? "active",
    usageCount: Number(r.usage_count ?? 0),
    successCount: Number(r.success_count ?? 0),
    failCount: Number(r.fail_count ?? 0),
    lastUsedAt: (r.last_used_at as string) ?? null,
    lastCheckedAt: (r.last_checked_at as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  };
}

const keyCols = `id, provider, label, api_key, status, usage_count, success_count, fail_count, last_used_at, last_checked_at, last_error, created_at`;

export async function insertKey(p: { provider: string; apiKey: string; label?: string }): Promise<KeyRow | null> {
  await ensureSchema();
  const dup = await getDb().execute({
    sql: `SELECT ${keyCols} FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [p.provider, p.apiKey],
  });
  if (dup.rows.length > 0) return null; // رفض التكرار لنفس المزود
  const id = crypto.randomUUID();
  // نكتب created_at بدقة مللي ثانية حتى يبقى الترتيب التسلسلي صارمًا حتى لو أُضيف مفتاحان بنفس الثانية
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    args: [id, p.provider, p.label ?? "", p.apiKey, nowIso()],
  });
  const created = await getDb().execute({ sql: `SELECT ${keyCols} FROM api_keys WHERE id = ?`, args: [id] });
  return rowToKey(created.rows[0] as unknown as Record<string, unknown>);
}

/** تجلب المفاتيح غير المعطّلة لهذه المزودات بترتيب الإضافة الصارم (الأول أُضيف يُجرَّب أولًا).
 *  المفتاح المستنزف يبقى في القائمة والقاعدة — الاستثناء الوحيد هو disabled اليدوي. */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const res = await getDb().execute({
    sql: `SELECT ${keyCols} FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as InValue[],
  });
  return res.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const res = await getDb().execute({ sql: `SELECT ${keyCols} FROM api_keys ORDER BY created_at ASC, id ASC`, args: [] });
  return res.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const res = await getDb().execute({ sql: `SELECT ${keyCols} FROM api_keys WHERE id = ?`, args: [id] });
  return res.rows.length ? rowToKey(res.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function updateKeyStatus(
  id: string,
  status: KeyRow["status"],
  lastError?: string | null,
): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = ? WHERE id = ?`,
    args: [status, lastError ?? null, nowIso(), id],
  });
}

/** عدّادات المفتاح تُحدَّث دائمًا بعد كل محاولة (نجاح أو فشل) مع آخر خطأ */
export async function bumpKeyCounters(id: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = ?,
            last_checked_at = ?,
            last_error = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, nowIso(), nowIso(), error ?? null, id],
  });
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const res = await getDb().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
  return res.rowsAffected > 0;
}
