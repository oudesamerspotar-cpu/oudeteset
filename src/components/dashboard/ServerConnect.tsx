"use client";

/**
 * ج) ربط السيرفر — الرابط المطلق لـ /mcp + JSON جاهز للنسخ لثلاث عائلات عملاء،
 * رقائق الأدوات الخمس، والملاحظة الكهرمانية عن توقيت الفيديو والتقدم الحي.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, PlugZap } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { HealthInfo } from "@/app/page";

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — تعيد الرابط مباشرة أو task_id للمتابعة." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي — task_id فوري وتتبع بـ get_task." },
  { name: "merge_videos", desc: "دمج حتى 10 مقاطع في فيديو واحد بالترتيب — urls أو task_ids." },
  { name: "get_task", desc: "تتبع أي مهمة بمعرفها — يحدّث الحالة حية من المزود أو خدمة الدمج." },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها من قاعدة البيانات." },
];

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* المتصفح قد يمنع الحافظة */
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} className="gap-1.5 border-zinc-700 text-zinc-300 h-8">
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "تم النسخ" : "نسخ"}
    </Button>
  );
}

export function ServerConnect({ health }: { health: HealthInfo | null }) {
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    const t0 = setTimeout(() => setOrigin(window.location.origin), 0);
    return () => clearTimeout(t0);
  }, []);

  const mcpUrl = origin ? `${origin}/mcp` : "";

  const configs = useMemo(() => {
    const headers = health?.authRequired
      ? `,\n        "headers": { "Authorization": "Bearer <ضع هنا قيمة MCP_ACCESS_TOKEN>" }`
      : "";
    const headersClaude = health?.authRequired
      ? `,\n      "headers": { "Authorization": "Bearer <ضع هنا قيمة MCP_ACCESS_TOKEN>" }`
      : "";
    return {
      chatgpt: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${headers}\n    }\n  }\n}`,
      claude: `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${headersClaude}\n    }\n  }\n}`,
      cursor: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${headers}\n    }\n  }\n}`,
    };
  }, [mcpUrl, health?.authRequired]);

  return (
    <Card className="border-zinc-800 bg-zinc-900/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlugZap className="h-4 w-4 text-emerald-400" />
          ربط السيرفر
        </CardTitle>
        <CardDescription className="text-xs">
          انسخ الإعداد المناسب لعميلك — عنوان الخادم هو <code dir="ltr">{mcpUrl || "<origin>/mcp"}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 p-4">
        {/* حقل الرابط + نسخ */}
        <div className="flex flex-wrap items-center gap-2">
          <Input readOnly dir="ltr" value={mcpUrl} className="bg-zinc-950 border-zinc-800 text-left font-mono text-xs max-w-md" />
          <CopyButton value={mcpUrl} />
          <span className="text-[11px] text-zinc-500">
            في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
          </span>
        </div>

        {/* تبويبات JSON */}
        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="bg-zinc-950 border border-zinc-800">
            <TabsTrigger value="chatgpt" className="text-xs data-[state=active]:bg-zinc-800">
              ChatGPT / GPT Agents
            </TabsTrigger>
            <TabsTrigger value="claude" className="text-xs data-[state=active]:bg-zinc-800">
              Claude Desktop
            </TabsTrigger>
            <TabsTrigger value="cursor" className="text-xs data-[state=active]:bg-zinc-800">
              Cursor / Windsurf / Cline
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="mt-3 space-y-2">
            <pre dir="ltr" className="text-[11px] leading-5 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-x-auto text-zinc-300 font-mono">
              {configs.chatgpt}
            </pre>
            <CopyButton value={configs.chatgpt} />
          </TabsContent>
          <TabsContent value="claude" className="mt-3 space-y-2">
            <pre dir="ltr" className="text-[11px] leading-5 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-x-auto text-zinc-300 font-mono">
              {configs.claude}
            </pre>
            <CopyButton value={configs.claude} />
          </TabsContent>
          <TabsContent value="cursor" className="mt-3 space-y-2">
            <pre dir="ltr" className="text-[11px] leading-5 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-x-auto text-zinc-300 font-mono">
              {configs.cursor}
            </pre>
            <CopyButton value={configs.cursor} />
          </TabsContent>
        </Tabs>

        {/* رقائق الأدوات الخمس */}
        <div>
          <p className="text-xs text-zinc-400 mb-2">الأدوات الخمس المتاحة على الخادم:</p>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <Badge
                key={t.name}
                variant="outline"
                className="border-zinc-700 bg-zinc-950/80 text-zinc-300 max-w-full h-auto py-1.5 ps-2 pe-3 text-start"
                title={t.desc}
              >
                <code dir="ltr" className="text-[11px] text-emerald-300 me-1.5">{t.name}</code>
                <span className="text-[10px] text-zinc-400 font-normal leading-4">{t.desc}</span>
              </Badge>
            ))}
          </div>
        </div>

        {/* الملاحظة الكهرمانية */}
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-xs leading-6 text-amber-200">
            الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط
            في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
