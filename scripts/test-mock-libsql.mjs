/** اختبار سريع لبروتوكول Hrana على الخادم الوهمي mock-libsql — نفس مسار @libsql/client/web المستخدم في المشروع */
import { createClient } from "@libsql/client/web";

const db = createClient({ url: process.env.MOCK_URL || "http://127.0.0.1:8087", authToken: "local-dev" });
await db.batch(
  [
    { sql: "CREATE TABLE IF NOT EXISTS t1 (id TEXT PRIMARY KEY, n INTEGER, d REAL, b BLOB)", args: [] },
    { sql: "INSERT INTO t1 (id, n, d, b) VALUES (?, ?, ?, ?)", args: ["a", 5, 2.5, new Uint8Array([1, 2, 3])] },
  ],
  "write",
);
const r = await db.execute({ sql: "SELECT * FROM t1 WHERE id = ?", args: ["a"] });
console.log("cols:", r.columns, "rows:", r.rows.length, "row:", JSON.stringify(r.rows[0]), "affected:", r.rowsAffected);
if (r.rows.length !== 1) throw new Error("SELECT لم يعيد الصف المدرج!");
const row = r.rows[0];
if (row.id !== "a" || Number(row.n) !== 5 || Number(row.d) !== 2.5) throw new Error("قيم الصف غير مطابقة!");
const b = row.b;
// عميل @libsql يرجع blob أحيانًا كـ ArrayBuffer وأحيانًا كـ Uint8Array — كلاهما يقبل Buffer.from
const bu = b instanceof Uint8Array ? b : new Uint8Array(b ?? new ArrayBuffer(0));
if (bu.length === 3 && bu[0] === 1 && bu[2] === 3) console.log("blob OK");
else throw new Error("blob فاسد!");
// تحديث ثم قراءة عبر batch
await db.batch([{ sql: "UPDATE t1 SET n = ? WHERE id = ?", args: [9, "a"] }], "write");
const r2 = await db.execute("SELECT n FROM t1");
if (Number(r2.rows[0].n) !== 9) throw new Error("التحديث لم يُطبق!");
await db.batch([{ sql: "DELETE FROM t1", args: [] }], "write");
const c = await db.execute("SELECT COUNT(*) AS n FROM t1");
console.log("count:", Number(c.rows[0].n));
console.log("OK — بروتوكول Hrana يعمل على node:sqlite");
