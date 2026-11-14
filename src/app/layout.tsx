import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

/* خط Cairo العربي عبر next/font — يُحمَّل ويُخزَّن أثناء البناء (لا اعتماد على CDN وقت التشغيل) */
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

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
    <html lang="ar" dir="rtl" className={`dark ${cairo.variable}`} suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground font-sans">{children}<Toaster /></body>
    </html>
  );
}
