/**
 * طبقة Turso — كل شيء مخزَّن فيها: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs).
 * لا S3 ولا خدمات خارجية ولا ملفات دائمة على القرص (/tmp فقط أثناء المعالجة).
 * كل Blob يُقسَّم إلى صفوف 2MB ويُقرأ تدفقيًا بصفحات من 8 صفوف.
 */
const { createClient } = require("@libsql/client/web");
const { Readable } = require("node:stream");
const { LIMITS } = require("./env");

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
}

const db = createClient({ url, authToken: token });

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db
      .batch(
        [
          {
            sql: `CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              progress INTEGER DEFAULT 0,
              sources_json TEXT NOT NULL,
              error TEXT,
              size INTEGER,
              duration REAL,
              resolution TEXT,
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              type TEXT DEFAULT 'merge',
              params_json TEXT DEFAULT '{}'
            )`,
            args: [],
          },
          {
            sql: `CREATE TABLE IF NOT EXISTS sources (
              job_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              kind TEXT NOT NULL,
              url TEXT,
              name TEXT,
              size INTEGER DEFAULT 0,
              mime TEXT,
              has_audio INTEGER,
              width INTEGER,
              height INTEGER,
              duration REAL,
              PRIMARY KEY (job_id, seq)
            )`,
            args: [],
          },
          {
            sql: `CREATE TABLE IF NOT EXISTS source_chunks (
              job_id TEXT NOT NULL,
              source_seq INTEGER NOT NULL,
              chunk_idx INTEGER NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY (job_id, source_seq, chunk_idx)
            )`,
            args: [],
          },
          {
            sql: `CREATE TABLE IF NOT EXISTS output_chunks (
              job_id TEXT NOT NULL,
              chunk_idx INTEGER NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY (job_id, chunk_idx)
            )`,
            args: [],
          },
          /* مقاطع العرض الصوري الوسيطة: كل صورة معالجة تُخزَّن هنا قبل الدمج النهائي */
          {
            sql: `CREATE TABLE IF NOT EXISTS clip_chunks (
              job_id TEXT NOT NULL,
              clip_seq INTEGER NOT NULL,
              chunk_idx INTEGER NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY (job_id, clip_seq, chunk_idx)
            )`,
            args: [],
          },
          { sql: `CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs (expires_at)`, args: [] },
        ],
        "write",
      )
      .then(() => migrateExisting())
      .catch((e) => {
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

/** ترحيل القواعد القائمة سابقًا: إضافة عمودي type و params_json إلى jobs (يتجاهل الخطأ إن ووجدا) */
let migrated = false;
async function migrateExisting() {
  if (migrated) return;
  for (const col of ["type TEXT DEFAULT 'merge'", "params_json TEXT DEFAULT '{}'"]) {
    const name = col.split(" ")[0];
    try {
      await db.execute({ sql: `ALTER TABLE jobs ADD COLUMN ${col}`, args: [] });
    } catch (e) {
      if (!String(e?.message ?? "").includes("duplicate column")) {
        // خطأ آخر غير "العمود موجود" — نسجله ونتابع (قد يكون عمودًا أُضيف للتو عبر مسار آخر)
        console.warn(`[db] ترحيل العمود ${name}: ${String(e?.message ?? e)}`);
      }
    }
  }
  migrated = true;
}

const nowIso = () => new Date().toISOString();
const expiresAtIso = () => new Date(Date.now() + LIMITS.JOB_TTL_HOURS * 3600 * 1000).toISOString();

function rowToJob(r) {
  const o = {};
  for (const k of Object.keys(r)) o[k] = r[k];
  let sources = [];
  try {
    sources = JSON.parse(o.sources_json || "[]");
  } catch {}
  let params = {};
  try {
    params = JSON.parse(o.params_json || "{}");
  } catch {}
  return {
    id: String(o.id),
    type: String(o.type ?? "merge"),
    params,
    status: String(o.status),
    progress: Number(o.progress ?? 0),
    sources,
    error: o.error || null,
    size: o.size === null || o.size === undefined ? null : Number(o.size),
    duration: o.duration === null || o.duration === undefined ? null : Number(o.duration),
    resolution: o.resolution || null,
    expiresAt: String(o.expires_at),
    createdAt: String(o.created_at),
  };
}

/* ===== المهام ===== */

async function createJob(sources, type = "merge", params = {}) {
  await ensureSchema();
  const id = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6); // معرف قصير قابل للمشاركة
  const created = nowIso();
  const expiresAt = expiresAtIso();
  await db.execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_json, expires_at, created_at, type, params_json) VALUES (?, 'queued', 0, ?, ?, ?, ?, ?)`,
    args: [id, JSON.stringify(sources), expiresAt, created, type, JSON.stringify(params)],
  });
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    await db.execute({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, s.seq, s.kind, s.url ?? null, s.name ?? null, s.size ?? 0, s.mime ?? null],
    });
  }
  return getJob(id);
}

async function getJob(id) {
  await ensureSchema();
  const res = await db.execute({ sql: `SELECT * FROM jobs WHERE id = ?`, args: [id] });
  if (res.rows.length === 0) return null;
  return rowToJob(res.rows[0]);
}

async function updateJob(id, patch) {
  await ensureSchema();
  const job = await getJob(id);
  if (!job) return;
  const status = patch.status ?? job.status;
  const progress = patch.progress !== undefined ? Math.max(0, Math.min(100, Math.round(patch.progress))) : job.progress;
  const error = patch.error !== undefined ? patch.error : patch.status === "failed" ? (patch.error ?? job.error) : patch.status === "processing" ? null : job.error;
  const size = patch.size !== undefined ? patch.size : job.size;
  const duration = patch.duration !== undefined ? patch.duration : job.duration;
  const resolution = patch.resolution !== undefined ? patch.resolution : job.resolution;
  await db.execute({
    sql: `UPDATE jobs SET status = ?, progress = ?, error = ?, size = ?, duration = ?, resolution = ? WHERE id = ?`,
    args: [status, progress, error, size, duration, resolution, id],
  });
}

/** التنظيف الكسول: كل المهام المنتهية (تجاوزت 24 ساعة) */
async function listExpiredJobs() {
  await ensureSchema();
  const now = nowIso();
  const res = await db.execute({
    sql: `SELECT id FROM jobs WHERE expires_at <= ?`,
    args: [now],
  });
  return res.rows.map((r) => String(r.id));
}

async function purgeExpiredJobs() {
  const ids = await listExpiredJobs();
  let deleted = 0;
  for (const id of ids) {
    if (await deleteJobCascade(id)) deleted++;
  }
  return { scanned: ids.length, deleted };
}

/** حذف شامل في batch واحد: jobs + sources + source_chunks + clip_chunks + output_chunks */
async function deleteJobCascade(id) {
  await ensureSchema();
  const check = await db.execute({ sql: `SELECT 1 FROM jobs WHERE id = ?`, args: [id] });
  if (check.rows.length === 0) return false;
  await db.batch(
    [
      { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM clip_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM sources WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM jobs WHERE id = ?`, args: [id] },
    ],
    "write",
  );
  return true;
}

/* ===== تخزين Blobs المقسمة ===== */

/** تقسيم Buffer إلى صفوف 2MB وإدراجها — يُستخدم لأجزاء الرفع وللناتج */
async function insertBlobRows(table, idCols, idVals, baseIndex, buffer) {
  const rows = Math.ceil(buffer.length / LIMITS.BLOB_ROW_BYTES);
  const stmts = [];
  for (let i = 0; i < rows; i++) {
    const chunk = buffer.subarray(i * LIMITS.BLOB_ROW_BYTES, (i + 1) * LIMITS.BLOB_ROW_BYTES);
    stmts.push({
      sql: `INSERT INTO ${table} (${idCols.join(", ")}, chunk_idx, data) VALUES (${idVals.map(() => "?").join(", ")}, ?, ?)`,
      args: [...idVals, baseIndex + i, new Uint8Array(chunk)],
    });
  }
  if (stmts.length > 0) await db.batch(stmts, "write");
  return rows;
}

/** رفع جزء من ملف مصدر (حتى 4MB) — يُقسَّم داخليًا لصفوف 2MB.
 *  قابل للتكرار (idempotent): الجزء رقم k يشغل صفوف 2MB [k*2, k*2+1] ويُستبدل عند إعادة الرفع بعد فشل شبكة. */
async function insertSourceChunk(jobId, seq, chunkIdx, buffer) {
  await ensureSchema();
  const rowsPerChunk = Math.ceil(LIMITS.UPLOAD_CHUNK_BYTES / LIMITS.BLOB_ROW_BYTES);
  const startRow = Math.max(0, chunkIdx) * rowsPerChunk;
  const del = [];
  for (let r = startRow; r < startRow + rowsPerChunk; r++) {
    del.push({ sql: `DELETE FROM source_chunks WHERE job_id = ? AND source_seq = ? AND chunk_idx = ?`, args: [jobId, seq, r] });
  }
  await db.batch(del, "write");
  return insertBlobRows("source_chunks", ["job_id", "source_seq"], [jobId, seq], startRow, buffer);
}

async function sourceChunkCount(jobId, seq) {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS bytes FROM source_chunks WHERE job_id = ? AND source_seq = ?`,
    args: [jobId, seq],
  });
  const r = res.rows[0];
  return { count: Number(r.n ?? 0), bytes: Number(r.bytes ?? 0) };
}

/** تجميع ملف مصدر من صفوفه إلى /tmp — يعيد المسار أو null إن كانت الأجزاء ناقصة */
async function assembleSource(jobId, seq, expectedSize, destPath) {
  await ensureSchema();
  const { bytes } = await sourceChunkCount(jobId, seq);
  if (expectedSize > 0 && bytes !== expectedSize) return null;
  const fs = require("node:fs");
  const fd = fs.openSync(destPath, "w");
  try {
    let lastIdx = 0;
    for (;;) {
      const page = await db.execute({
        sql: `SELECT chunk_idx, data FROM source_chunks WHERE job_id = ? AND source_seq = ? AND chunk_idx >= ? ORDER BY chunk_idx LIMIT ${LIMITS.BLOB_PAGE_ROWS}`,
        args: [jobId, seq, lastIdx],
      });
      if (page.rows.length === 0) break;
      for (const r of page.rows) {
        const buf = Buffer.from(r.data);
        fs.writeSync(fd, buf);
        lastIdx = Number(r.chunk_idx) + 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return destPath;
}

/** حفظ ملف الناتج من /tmp إلى صفوف output_chunks (2MB لكل صف) */
async function saveOutput(jobId, filePath) {
  await ensureSchema();
  const fs = require("node:fs");
  const buffer = fs.readFileSync(filePath);
  return insertBlobRows("output_chunks", ["job_id"], [jobId], 0, buffer);
}

/* ===== مقاطع العرض الصوري الوسيطة (clip_chunks) ===== */

/** حفظ مقطع صورة معالَج (Buffer ≤ ~10MB) — يستبدل أي نسخة سابقة لنفس seq (قابل للتكرار). يعيد الحجم بالبايت */
async function saveClip(jobId, clipSeq, buffer) {
  await ensureSchema();
  await db.batch(
    [{ sql: `DELETE FROM clip_chunks WHERE job_id = ? AND clip_seq = ?`, args: [jobId, clipSeq] }],
    "write",
  );
  await insertBlobRows("clip_chunks", ["job_id", "clip_seq"], [jobId, clipSeq], 0, buffer);
  return buffer.length;
}

async function clipBytes(jobId, clipSeq) {
  const res = await db.execute({
    sql: `SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM clip_chunks WHERE job_id = ? AND clip_seq = ?`,
    args: [jobId, clipSeq],
  });
  return Number(res.rows[0].bytes ?? 0);
}

/** قائمة المقاطع الجاهزة: [{seq, bytes}] مرتبة */
async function listClips(jobId) {
  await ensureSchema();
  const res = await db.execute({
    sql: `SELECT clip_seq, COALESCE(SUM(length(data)), 0) AS bytes FROM clip_chunks WHERE job_id = ? GROUP BY clip_seq ORDER BY clip_seq`,
    args: [jobId],
  });
  return res.rows.map((r) => ({ seq: Number(r.clip_seq), bytes: Number(r.bytes ?? 0) }));
}

/** تجميع مقطع من صفوفه إلى /tmp — يعيد المسار أو null إن لم يوجد */
async function assembleClip(jobId, clipSeq, destPath) {
  await ensureSchema();
  const bytes = await clipBytes(jobId, clipSeq);
  if (bytes <= 0) return null;
  const fs = require("node:fs");
  const fd = fs.openSync(destPath, "w");
  try {
    let lastIdx = 0;
    for (;;) {
      const page = await db.execute({
        sql: `SELECT chunk_idx, data FROM clip_chunks WHERE job_id = ? AND clip_seq = ? AND chunk_idx >= ? ORDER BY chunk_idx LIMIT ${LIMITS.BLOB_PAGE_ROWS}`,
        args: [jobId, clipSeq, lastIdx],
      });
      if (page.rows.length === 0) break;
      for (const r of page.rows) {
        fs.writeSync(fd, Buffer.from(r.data));
        lastIdx = Number(r.chunk_idx) + 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return destPath;
}

async function outputSize(jobId) {
  const res = await db.execute({
    sql: `SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM output_chunks WHERE job_id = ?`,
    args: [jobId],
  });
  return Number(res.rows[0].bytes ?? 0);
}

/** قراءة الناتج كـ Readable مع دعم Range — صفحات من 8 صفوف مع تقليم أول/آخر جزء حسب المدى المطلوب */
function readOutputStream(jobId, range) {
  const start = range ? range.start : 0;
  const end = range ? range.end : null; // null = حتى النهاية
  let lastIdx = 0;
  let skipped = 0;
  let finished = false;

  return new Readable({
    async read() {
      if (finished) return;
      try {
        const page = await db.execute({
          sql: `SELECT chunk_idx, data FROM output_chunks WHERE job_id = ? AND chunk_idx >= ? ORDER BY chunk_idx LIMIT ${LIMITS.BLOB_PAGE_ROWS}`,
          args: [jobId, lastIdx],
        });
        if (page.rows.length === 0) {
          finished = true;
          this.push(null);
          return;
        }
        for (const r of page.rows) {
          let buf = Buffer.from(r.data);
          const chunkStartGlobal = skipped;
          skipped += buf.length; // بعد الزيادة: النهاية العالمية (الحصرية) لهذا الصف
          lastIdx = Number(r.chunk_idx) + 1;
          // الصف يقع كاملًا قبل بداية المدى → تجاوزه
          if (chunkStartGlobal + buf.length <= start) continue;
          // تقليم البداية حسب المدى
          if (chunkStartGlobal < start) buf = buf.subarray(start - chunkStartGlobal);
          // تقليم النهاية حسب المدى (نقارن بنهاية الصف الأصلية قبل أي تقليم)
          if (end !== null && end !== undefined) {
            if (chunkStartGlobal > end) {
              finished = true;
              this.push(null);
              return;
            }
            // نقطة بداية الـ buf الحالية على الإحداثي العالمي (بعد تقليم بداية المدى)
            const off0 = Math.max(start, chunkStartGlobal);
            if (skipped > end + 1) buf = buf.subarray(0, end + 1 - off0);
            if (buf.length === 0) {
              finished = true;
              this.push(null);
              return;
            }
          }
          if (!this.push(buf)) return; // backpressure — يُعاد النشاط عند read التالية
        }
      } catch (e) {
        finished = true;
        this.destroy(e);
      }
    },
  });
}

async function outputChunkCount(jobId) {
  const res = await db.execute({ sql: `SELECT COUNT(*) AS n FROM output_chunks WHERE job_id = ?`, args: [jobId] });
  return Number(res.rows[0].n ?? 0);
}

module.exports = {
  db,
  ensureSchema,
  createJob,
  getJob,
  updateJob,
  deleteJobCascade,
  purgeExpiredJobs,
  insertSourceChunk,
  sourceChunkCount,
  assembleSource,
  saveOutput,
  outputSize,
  outputChunkCount,
  readOutputStream,
  saveClip,
  clipBytes,
  listClips,
  assembleClip,
  nowIso,
};
