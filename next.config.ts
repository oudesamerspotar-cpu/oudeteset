import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // يسمح ببناء إنتاجية في مجلد منفصل أثناء عمل خادم التطوير (NEXT_DIST_DIR=.next-prodcheck)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /* libsql عبر HTTP فقط للتوافق مع Vercel serverless — تستثنى من تجميع الحزمة */
  serverExternalPackages: ["@libsql/client"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
