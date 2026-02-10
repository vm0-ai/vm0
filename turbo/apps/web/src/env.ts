import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

function initEnv() {
  return createEnv({
    server: {
      DATABASE_URL: z.string().min(1),
      NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
      // Database pool configuration
      DB_POOL_MAX: z.coerce.number().int().positive().default(10),
      DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().optional(),
      DB_POOL_CONNECT_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(10000),
      CLERK_SECRET_KEY: z.string().min(1),
      E2B_API_KEY: z.string().min(1),
      VM0_API_URL: z.string().url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
      VERCEL_URL: z.string().optional(),
      R2_ACCOUNT_ID: z.string().min(1),
      R2_ACCESS_KEY_ID: z.string().min(1),
      R2_SECRET_ACCESS_KEY: z.string().min(1),
      R2_USER_STORAGES_BUCKET_NAME: z.string().min(1),
      SECRETS_ENCRYPTION_KEY: z.string().length(64), // 32-byte hex key for AES-256
      OFFICIAL_RUNNER_SECRET: z.string().length(64).optional(), // 32-byte hex key for official runner auth
      AXIOM_TOKEN_SESSIONS: z.string().min(1).optional(), // Scoped token for agent-run-events
      AXIOM_TOKEN_TELEMETRY: z.string().min(1).optional(), // Scoped token for all other datasets
      AXIOM_DATASET_SUFFIX: z.enum(["dev", "prod"]).optional(), // Explicit control for Axiom dataset suffix
      // Slack integration
      SLACK_CLIENT_ID: z.string().min(1),
      SLACK_CLIENT_SECRET: z.string().min(1),
      SLACK_SIGNING_SECRET: z.string().min(1),
      SLACK_REDIRECT_BASE_URL: z.string().url(), // Override base URL for OAuth redirects (e.g., tunnel URL)
      // GitHub OAuth (for connector)
      GH_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      GH_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Platform UI URL (for settings page links in error messages)
      PLATFORM_URL: z.string().url().optional(),
      // Sentry
      SENTRY_DSN: z.string().url().optional(),
      SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
      SENTRY_ORG: z.string().min(1).optional(),
      SENTRY_PROJECT: z.string().min(1).optional(),
    },
    client: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
      NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      DB_POOL_MAX: process.env.DB_POOL_MAX,
      DB_POOL_IDLE_TIMEOUT_MS: process.env.DB_POOL_IDLE_TIMEOUT_MS,
      DB_POOL_CONNECT_TIMEOUT_MS: process.env.DB_POOL_CONNECT_TIMEOUT_MS,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      E2B_API_KEY: process.env.E2B_API_KEY,
      VM0_API_URL: process.env.VM0_API_URL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      R2_USER_STORAGES_BUCKET_NAME: process.env.R2_USER_STORAGES_BUCKET_NAME,
      SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
      OFFICIAL_RUNNER_SECRET: process.env.OFFICIAL_RUNNER_SECRET,
      AXIOM_TOKEN_SESSIONS: process.env.AXIOM_TOKEN_SESSIONS,
      AXIOM_TOKEN_TELEMETRY: process.env.AXIOM_TOKEN_TELEMETRY,
      AXIOM_DATASET_SUFFIX: process.env.AXIOM_DATASET_SUFFIX,
      SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
      SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
      SLACK_REDIRECT_BASE_URL: process.env.SLACK_REDIRECT_BASE_URL,
      GH_OAUTH_CLIENT_ID: process.env.GH_OAUTH_CLIENT_ID,
      GH_OAUTH_CLIENT_SECRET: process.env.GH_OAUTH_CLIENT_SECRET,
      PLATFORM_URL: process.env.PLATFORM_URL,
      SENTRY_DSN: process.env.SENTRY_DSN,
      SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    },
    emptyStringAsUndefined: true,
  });
}

/**
 * Environment configuration schema
 * Call this function to get validated environment variables
 */
let _env: ReturnType<typeof initEnv> | undefined;
export function env() {
  if (!_env) {
    _env = initEnv();
  }

  return _env;
}

// Export type for type inference
export type Env = ReturnType<typeof env>;

export function reloadEnv() {
  _env = initEnv();
}
