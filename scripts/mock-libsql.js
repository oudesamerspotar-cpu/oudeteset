/**
 * خادم Turso/SQLite وهمي محلي — يحاكي بروتوكول Hrana over HTTP (v2/pipeline)
 * الذي يتحدث إليه @libsql/client/web في تطبيق Next وخدمة video-merger.
 * الغرض: اختبار محلي كامل عندما لا تتوفر بيانات Turso حقيقية في الصندوق.
 * الخلفية: node:sqlite (مدمج في Node 24) على ملف قاعدة بيانات محلي.
 *
 * الاستخدام: node scripts/mock-libsql.js  (منفذ 8087 افتراضيًا، متغير PORT_MOCK)
 * التشغيل مع التطبيق: TURSO_DATABASE_URL=http://127.0.0.1:8087 TURSO_AUTH_TOKEN=local-dev
 *
 * البروتوكول المنفذ (وفق مصدر @libsql/hrana-client lib-esm/http):
 * - الطلب:  {baton?: string, requests: [{type:"execute"|"batch"|"store_sql"|"close_sql"|"sequence"|"close", ...}]}
 * - الرد:   {baton: string, results: [{type:"ok", response} | {type:"error", error:{message, code?}}]}
 * - execute: stmt {sql | sql_id, args[Value], want_rows} → result {cols, rows[][], affected_row_count, last_insert_rowid?}
 * - batch:   {steps:[{condition?, stmt}]} → result {step_results[], step_errors[]}
 * - Value داخل: null | {integer,value:".."} | {float,value} | {text,value} | {blob,base64}
 * - Value خارج: null | {integer,value:".."} | {float,value} | {text,value} | {blob,base64}
 * ملاحظات:
 * - شروط الـ batch (ok/not/is_autocommit) تُتجاهل عمدًا — كل الخطوات تُنفذ بالترتيب (يكفي للتطوير).
 * - مخازن sql_id لكل baton منفصلة (كل stream له معرفاته من 1).
 */
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT_MOCK || 8087);
const DB_FILE = process.env.MOCK_DB_FILE || "/tmp/mock-turso-" + process.pid + ".db";
if (fs.existsSync(DB_FILE)) fs.rmSync(DB_FILE);
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode=WAL");

const batons = new Map(); // baton -> Map(sqlId -> sql)
let batonSeq = 0;
const newBaton = () => `mock-baton-${++batonSeq}-${Date.now()}`;

/* ===== تحويل القيم ===== */
function decodeArg(v) {
  if (!v || v.type === "null") return null;
  switch (v.type) {
    case "integer": return Number(BigInt(v.value));
    case "float": return Number(v.value);
    case "text": return String(v.value);
    case "blob": return Buffer.from(v.base64 ?? "", "base64");
    default: throw new Error(`نوع قيمة غير مدعوم: ${v?.type}`);
  }
}

function encodeOut(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  }
  if (typeof v === "bigint") return { type: "integer", value: String(v) };
  if (typeof v === "string") return { type: "text", value: v };
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return { type: "blob", base64: Buffer.from(v).toString("base64") };
  return { type: "text", value: String(v) };
}

/* ===== تنفيذ عبارة =====
 * قاعدة node:sqlite الحاسمة: تُنفَّذ العبارة مرة واحدة فقط —
 * want_rows=true → all() (تُشغّل العبارة وتعيد الصفوف ككائنات)، want_rows=false → run().
 * لا يجوز run() ثم all() على نفس العبارة (run يستهلك التنفيذ ولا يُعاد).
 */
function execStmt(sqlText, stmt) {
  const args = (stmt.args ?? []).map(decodeArg);
  for (const na of stmt.named_args ?? []) {
    // named args غير مستخدمة في هذا المشروع — دعم أدنى
    if (na?.name) sqlText = sqlText.replace(new RegExp(`[:@]${na.name}\\b`), "?");
    args.push(decodeArg(na?.value));
  }
  const wantRows = stmt.want_rows !== false;
  console.log(`[mock-libsql] exec: ${sqlText.slice(0, 90).replace(/\s+/g, " ")} | args=${args.length} wantRows=${wantRows}`);
  const stmtPrepared = db.prepare(sqlText);
  if (wantRows) {
    let rows = [];
    try {
      rows = args.length > 0 ? stmtPrepared.all(...args) : stmtPrepared.all();
    } catch (e) {
      console.log(`[mock-libsql] all-ERR: ${e.message}`);
      throw e;
    }
    let cols = [];
    try {
      cols = (stmtPrepared.columns?.() ?? []).map((c) => ({ name: c?.name ?? c?.column ?? "" }));
    } catch { cols = []; }
    if (cols.length === 0 && rows.length > 0 && typeof rows[0] === "object") {
      cols = Object.keys(rows[0]).map((name) => ({ name }));
    }
    const outRows = rows.map((r) => cols.map((c) => r[c.name]));
    return { cols, rows: outRows.map((r) => r.map(encodeOut)), affected_row_count: 0 };
  }
  let result;
  try {
    result = args.length > 0 ? stmtPrepared.run(...args) : stmtPrepared.run();
  } catch (e) {
    console.log(`[mock-libsql] run-ERR: ${e.message}`);
    throw e;
  }
  const res = { cols: [], rows: [], affected_row_count: Number(result?.changes ?? 0) };
  const lid = result?.lastInsertRowid;
  if (lid !== undefined && lid !== null && Number(lid) > 0) res.last_insert_rowid = String(lid);
  return res;
}

/* ===== معالجة طلب pipeline ===== */
function handleRequest(req, batonMap) {
  const type = req.type;
  if (type === "close") return { type: "close" };
  if (type === "store_sql") { batonMap.set(Number(req.sql_id), String(req.sql)); return { type: "store_sql" }; }
  if (type === "close_sql") { batonMap.delete(Number(req.sql_id)); return { type: "close_sql" }; }
  if (type === "sequence") {
    db.exec(String(req.sql ?? ""));
    return { type: "sequence" };
  }
  if (type === "get_autocommit") return { type: "get_autocommit", isAutocommit: !db.isTransaction };
  if (type === "describe") return { type: "describe", result: { params: [], cols: [], is_explain: false, is_readonly: false } };
  if (type === "execute") {
    const stmt = req.stmt ?? {};
    const sqlText = stmt.sql ?? batonMap.get(Number(stmt.sql_id));
    if (!sqlText) throw new Error(`لا يوجد SQL للمعرف ${stmt.sql_id}`);
    return { type: "execute", result: execStmt(sqlText, stmt) };
  }
  if (type === "batch") {
    const stepResults = [];
    const stepErrors = [];
    for (const step of req.batch?.steps ?? []) {
      const stmt = step?.stmt ?? {};
      try {
        const sqlText = stmt.sql ?? batonMap.get(Number(stmt.sql_id));
        if (!sqlText) throw new Error(`لا يوجد SQL للمعرف ${stmt.sql_id}`);
        // ملاحظة صيغة Hrana: عناصر step_results هي StmtResult مباشرة (بلا غلاف {type,result})
        stepResults.push(execStmt(sqlText, stmt));
        stepErrors.push(null);
      } catch (e) {
        stepResults.push(null);
        stepErrors.push({ message: String(e?.message ?? e), code: "SQLITE_ERROR" });
      }
    }
    return { type: "batch", result: { step_results: stepResults, step_errors: stepErrors } };
  }
  throw new Error(`نوع طلب غير مدعوم: ${type}`);
}

const server = http.createServer((req, res) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); return res.end(); }
  if (req.method === "GET") { res.writeHead(200, { ...corsHeaders, "Content-Type": "text/plain" }); return res.end("mock-libsql ready"); }
  if (req.method !== "POST" || !req.url.includes("pipeline")) {
    res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "غير موجود" }));
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "JSON تالف" })); }
    const baton = typeof body.baton === "string" && body.baton ? body.baton : newBaton();
    if (!batons.has(baton)) batons.set(baton, new Map());
    const batonMap = batons.get(baton);
    const results = [];
    let hadError = false;
    for (const r of body.requests ?? []) {
      try { results.push({ type: "ok", response: handleRequest(r, batonMap) }); }
      catch (e) { results.push({ type: "error", error: { message: String(e?.message ?? e), code: "MOCK_ERROR" } }); hadError = true; }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ baton, results }));
    if (hadError) batons.delete(baton); // العميل يغلق stream عند الخطأ
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-libsql] يعمل على http://127.0.0.1:${PORT} — القاعدة: ${DB_FILE}`);
});
