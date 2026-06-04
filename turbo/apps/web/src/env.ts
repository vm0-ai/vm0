import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Whether the blog feature is available.
 *
 * Derived from the presence of a Strapi URL. No Strapi = no blog.
 */
export function isBlogEnabled(): boolean {
  return !!(process.env.NEXT_PUBLIC_STRAPI_URL ?? process.env.STRAPI_URL);
}

function initEnv() {
  return createEnv({
    server: {
      NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
      CLERK_SECRET_KEY: z.string().min(1),
      VM0_API_URL: z.url().optional(),
      VM0_API_BACKEND_URL: z.url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
      GOOGLE_SITE_VERIFICATION: z.string().min(1).optional(),
      MONDAY_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      MONDAY_OAUTH_APP_ID: z.string().min(1).optional(),
      SENTRY_DSN_WEB: z.url().optional(),
      SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
      SENTRY_ORG: z.string().min(1).optional(),
      SENTRY_PROJECT: z.string().min(1).optional(),
      VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
    },
    client: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
      NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),
      NEXT_PUBLIC_BASE_URL: z.url().optional(),
      NEXT_PUBLIC_DATA_SOURCE: z.string().optional(),
      NEXT_PUBLIC_STRAPI_URL: z.url().optional(),
      NEXT_PUBLIC_APP_URL: z.url(),
      NEXT_PUBLIC_PAID_ONBOARDING_URL: z.url().optional(),
      NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL: z.url().optional(),
      NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
      NEXT_PUBLIC_POSTHOG_HOST: z.url().optional(),
    },
    runtimeEnv: {
      NODE_ENV: process.env.NODE_ENV,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      VM0_API_URL:
        process.env.VM0_API_URL ??
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : undefined),
      VM0_API_BACKEND_URL:
        process.env.VM0_API_BACKEND_URL ??
        (process.env.VERCEL_ENV === "production"
          ? "https://vm0-api.vm6.ai"
          : process.env.VERCEL_ENV === undefined
            ? "http://localhost:3001"
            : undefined),
      VERCEL_ENV: process.env.VERCEL_ENV,
      GOOGLE_SITE_VERIFICATION: process.env.GOOGLE_SITE_VERIFICATION,
      MONDAY_OAUTH_CLIENT_ID: process.env.MONDAY_OAUTH_CLIENT_ID,
      MONDAY_OAUTH_APP_ID: process.env.MONDAY_OAUTH_APP_ID,
      SENTRY_DSN_WEB: process.env.SENTRY_DSN_WEB,
      SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
      VERCEL_AUTOMATION_BYPASS_SECRET:
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET,

      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
        process.env.CLERK_PUBLISHABLE_KEY,
      NEXT_PUBLIC_SENTRY_DSN:
        process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN_WEB,
      NEXT_PUBLIC_BASE_URL:
        process.env.NEXT_PUBLIC_BASE_URL ?? process.env.BLOG_BASE_URL,
      NEXT_PUBLIC_DATA_SOURCE:
        process.env.NEXT_PUBLIC_DATA_SOURCE ?? process.env.BLOG_DATA_SOURCE,
      NEXT_PUBLIC_STRAPI_URL:
        process.env.NEXT_PUBLIC_STRAPI_URL ?? process.env.STRAPI_URL,
      NEXT_PUBLIC_APP_URL:
        process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL,
      NEXT_PUBLIC_PAID_ONBOARDING_URL:
        process.env.NEXT_PUBLIC_PAID_ONBOARDING_URL ??
        process.env.PAID_ONBOARDING_URL,
      NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL:
        process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL ??
        process.env.PLAUSIBLE_SCRIPT_URL,
      NEXT_PUBLIC_POSTHOG_KEY:
        process.env.NEXT_PUBLIC_POSTHOG_KEY ?? process.env.POSTHOG_KEY,
      NEXT_PUBLIC_POSTHOG_HOST:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ?? process.env.POSTHOG_HOST,
    },
    emptyStringAsUndefined: true,
  });
}

/**
 * Environment configuration schema.
 * Call this function to get validated environment variables.
 */
let _env: ReturnType<typeof initEnv> | undefined;
export function env() {
  if (!_env) {
    _env = initEnv();
  }

  return _env;
}

/**
 * @internal Test-only cache reset for env-sensitive web integration tests.
 */
export function reloadEnv() {
  _env = initEnv();
}
