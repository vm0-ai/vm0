import { withSentryConfig } from "@sentry/nextjs";
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
  allowedDevOrigins: ["*.vm7.ai"],
  serverExternalPackages: ["ably"],
};

export default withSentryConfig(withNextIntl(nextConfig), {
  // Sentry organization and project
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Auth token for source map uploads
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress logs during build
  silent: true,

  // Hide source maps from production bundle
  hideSourceMaps: true,

  // Disable telemetry
  telemetry: false,
});
