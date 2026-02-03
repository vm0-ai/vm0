import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // CI already runs lint separately, skip during Vercel build to save time and memory
    ignoreDuringBuilds: true,
  },
  typescript: {
    // CI already runs type-check separately, skip during Vercel build to save time and memory
    ignoreBuildErrors: true,
  },
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.strapiapp.com",
      },
      {
        protocol: "https",
        hostname: "**.media.strapiapp.com",
      },
    ],
  },
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? {
            exclude: ["error", "warn"],
          }
        : false,
  },
  experimental: {
    optimizePackageImports: ["next-intl"],
  },
  // Proxy all unmatched routes to web app
  async rewrites() {
    const webUrl = process.env.WEB_APP_URL;
    if (!webUrl) return [];

    return {
      // beforeFiles: checked before pages/public files
      beforeFiles: [
        // Proxy _next/static (build assets from web)
        {
          source: "/_next/static/:path*",
          destination: `${webUrl}/_next/static/:path*`,
        },
      ],
      // fallback: checked after pages/public files (404 would go here)
      fallback: [
        // Proxy everything else to web
        {
          source: "/:path*",
          destination: `${webUrl}/:path*`,
        },
      ],
    };
  },
};

export default withNextIntl(nextConfig);
