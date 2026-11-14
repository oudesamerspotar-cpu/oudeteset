/**
 * خادم MCP على /mcp — نقل Streamable HTTP حسب مواصفة MCP باستخدام SDK الرسمي.
 * runtime=nodejs + force-dynamic إلزاميان (لا تخزين ولا تحويل static).
 *
 * لماذا WebStandardStreamableHTTPServerTransport؟ لأن SDK الحديث يبني النقل فوق Web Standard،
 * وهو مطابق تمامًا لواجهة Request/Response في Next.js App Router — يدعم بث SSE للردود
 * فيبثّ إشعارات التقدم الحي فعلًا أثناء نافذة الانتظار.
 *
 * وضع Stateless: جلسة جديدة لكل طلب (sessionIdGenerator: undefined) — لا اعتماد على ذاكرة
 * بين الطلبات، وهذا إلزامي للتوافق مع Vercel serverless (مواصفة Streamable HTTP تسمح به).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار قد تمتد حتى 240 ثانية + هامش — 300 كحد أقصى للدالة (Pro على Vercel)
export const maxDuration = 300;

/** حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token> على /mcp */
function checkAuth(req: Request): boolean {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

function rpcError(code: number, message: string, status: number): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!checkAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(-32700, "Parse error: جسم الطلب ليس JSON صالحًا", 400);
  }

  // خادم ونقل جديدان لكل طلب — إلزامي في وضع stateless حسب SDK ولا تسرّب حالة بين الطلبات
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req, { parsedBody: body });

    // البث يبقى مفتوحًا لكل إشعارات التقدم حتى الاكتمال — ثم نغلق الأدوات المرتبطة بالطلب
    if (response.body) {
      const cleaned = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          flush() {
            void transport.close();
            void server.close();
          },
        }),
      );
      return new Response(cleaned, { status: response.status, headers: response.headers });
    }
    void transport.close();
    void server.close();
    return response;
  } catch {
    try {
      await transport.close();
      await server.close();
    } catch {
      /* تجاهل */
    }
    return rpcError(-32603, "Internal server error: عطل داخلي في خادم MCP", 500);
  }
}

export async function GET(): Promise<Response> {
  // وضع stateless لا يوفر قناة GET طويلة الأمد للرسائل المبدئية من السيرفر — مواصفة MCP تسمح برد 405
  return rpcError(-32000, "Method Not Allowed: وضع stateless لا يوفر قناة GET — استخدم POST", 405);
}

export async function DELETE(): Promise<Response> {
  // لا جلسات في الذاكرة لإنهائها — مواصفة MCP تسمح برد 405 عندما لا تُدعم إدارة الجلسات
  return rpcError(-32000, "Method Not Allowed: وضع stateless بلا جلسات لإنهائها", 405);
}
