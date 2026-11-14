import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

/*
 * خط Cairo العربي عبر رابط CSS عادي (وقت التشغيل من المتصفح) بدل next/font/google —
 * لا تنزيل للخط وقت البناء، فلا يفشل next build عند تعذر الوصول إلى Google Fonts (كما حدث على Vercel).
 * مع تعطل الـ CDN يسقط العرض تلقائيًا على خطوط النظام المعرفة في --font-sans داخل globals.css.
 */

/*
 * واجهة عربية RTL بالكامل — dir="rtl" و lang="ar" من أول لحظة.
 */
export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع مدير مفاتيح متسلسل ولوحة متابعة حية.",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" className="dark" suppressHydrationWarning>
      <head>
        {/* رابط CSS عادي — يحمّله المتصفح وقت التشغيل، ولا يمس خطوة البناء إطلاقًا */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router: الـ head في الـ layout الجذري يطبّق على كل الصفحات */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body className="antialiased bg-background text-foreground font-sans">{children}<Toaster /></body>
    </html>
  );
}
