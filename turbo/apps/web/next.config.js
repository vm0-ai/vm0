import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Map clean environment variable names to NEXT_PUBLIC_ prefixed versions
  // This allows .env.local to use clearer names while Next.js still inlines them
  env: {
    // Sentry (used by both server and client)
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN_WEB,

    // Clerk authentication
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,

    // Platform URLs
    NEXT_PUBLIC_PLATFORM_URL: process.env.PLATFORM_URL,

    // Blog configuration
    NEXT_PUBLIC_BASE_URL: process.env.BLOG_BASE_URL,
    NEXT_PUBLIC_STRAPI_URL: process.env.STRAPI_URL,
    NEXT_PUBLIC_DATA_SOURCE: process.env.BLOG_DATA_SOURCE,
  },

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
    optimizePackageImports: [
      "next-intl",
      "@tabler/icons-react",
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-request-presigner",
      "@radix-ui/react-dialog",
      "@radix-ui/react-popover",
      "@radix-ui/react-select",
      "@radix-ui/react-tooltip",
      "@sentry/nextjs",
    ],
  },
  allowedDevOrigins: ["*.vm7.ai"],
  serverExternalPackages: ["ably", "dockerode"],
  webpack: (config) => {
    config.ignoreWarnings = [
      // e2b SDK uses dynamic require() for cross-runtime compatibility (Node/Deno/Bun)
      { module: /node_modules\/e2b\/dist/ },
      // next-intl uses dynamic import(t) internally for format loading
      { module: /node_modules\/next-intl\/dist/ },
      // Webpack cache serialization performance hints for large strings
      { message: /Serializing big strings/ },
    ];
    return config;
  },
};

const isProduction = process.env.VERCEL_ENV === "production";

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

  // Skip source map upload for non-production builds (preview deploys)
  sourcemaps: {
    disable: !isProduction,
  },
});
