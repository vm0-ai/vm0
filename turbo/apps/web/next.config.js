import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";
import { API_BACKEND_REWRITES } from "./api-backend-rewrites.js";

const withNextIntl = createNextIntlPlugin("./i18n.ts");

/** @type {import('next').NextConfig} */
// Model page slug redirects:
// - dotted slugs were originally published with a dot (e.g. `/models/kimi-k2.6`)
//   and trip Next.js's "looks like a static asset" matcher in proxy.ts.
// - removed model pages redirect to their replacement model pages instead of
//   leaving old public URLs as dead ends.
const MODEL_SLUG_REDIRECTS = [
  ["kimi-k2.6", "kimi-k2-6"],
  ["kimi-k2.5", "kimi-k2-5"],
  ["glm-5.1", "glm-5-1"],
  ["claude-haiku-4-5", "claude-sonnet-4-6"],
  ["deepseek-v4-flash", "deepseek-v4-pro"],
  ["minimax-m2.7", "minimax-m3"],
  ["minimax-m2-7", "minimax-m3"],
];

function resolveApiBackendUrl() {
  const apiBackendUrl = process.env.VM0_API_BACKEND_URL?.trim();
  return (
    apiBackendUrl ||
    (process.env.VERCEL_ENV === "production"
      ? "https://vm0-api.vm6.ai"
      : process.env.VERCEL_ENV === undefined
        ? "http://localhost:3001"
        : undefined)
  );
}

function buildApiBackendDestination(path) {
  const apiBackendUrl = resolveApiBackendUrl();
  if (!apiBackendUrl) {
    return undefined;
  }
  return `${apiBackendUrl.replace(/\/$/u, "")}${path}`;
}

const nextConfig = {
  async redirects() {
    return MODEL_SLUG_REDIRECTS.flatMap(([from, to]) => [
      {
        source: `/models/${from}`,
        destination: `/models/${to}`,
        permanent: true,
      },
      {
        source: `/:locale/models/${from}`,
        destination: `/:locale/models/${to}`,
        permanent: true,
      },
    ]);
  },
  async rewrites() {
    return {
      beforeFiles: API_BACKEND_REWRITES.flatMap(([source, destinationPath]) => {
        const destination = buildApiBackendDestination(destinationPath);
        if (!destination) {
          return [];
        }
        return [{ source, destination }];
      }),
    };
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Content-Security-Policy",
            value:
              "default-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none';",
          },
        ],
      },
    ];
  },

  // Map clean environment variable names to NEXT_PUBLIC_ prefixed versions
  // This allows .env.local to use clearer names while Next.js still inlines them
  env: {
    // Sentry (used by both server and client)
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN_WEB,

    // Clerk authentication
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,

    // App URLs
    NEXT_PUBLIC_APP_URL: process.env.APP_URL,

    // Paid-onboarding origin (so.vm0.ai) allowed as a post-auth redirect target
    NEXT_PUBLIC_PAID_ONBOARDING_URL: process.env.PAID_ONBOARDING_URL,

    // Blog configuration
    NEXT_PUBLIC_BASE_URL: process.env.BLOG_BASE_URL,
    NEXT_PUBLIC_STRAPI_URL: process.env.STRAPI_URL,
    NEXT_PUBLIC_DATA_SOURCE: process.env.BLOG_DATA_SOURCE,

    // Analytics (Plausible)
    NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL: process.env.PLAUSIBLE_SCRIPT_URL,
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
      {
        protocol: "https",
        hostname: "cdn.vm0.io",
      },
      {
        protocol: "https",
        hostname: "**.sites.vm0.io",
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
      "@radix-ui/react-dialog",
      "@radix-ui/react-popover",
      "@radix-ui/react-select",
      "@radix-ui/react-tooltip",
      "@sentry/nextjs",
    ],
  },
  allowedDevOrigins: ["*.vm7.ai"],
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
