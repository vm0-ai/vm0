import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const isSelfHosted = process.env.SELF_HOSTED === "true";

const slackEnabled =
  !isSelfHosted || process.env.SLACK_INTEGRATION_ENABLED === "true";
const e2bEnabled = !isSelfHosted || process.env.E2B_ENABLED === "true";

/**
 * Make a field required only when a condition is true, otherwise optional.
 * In SaaS mode all conditions default to true, so behavior is unchanged.
 */
function requiredWhen(condition: boolean, schema = z.string().min(1)) {
  return condition ? schema : schema.optional();
}

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
      SELF_HOSTED: z.enum(["true", "false"]).optional(),
      CLERK_SECRET_KEY: requiredWhen(!isSelfHosted),
      E2B_ENABLED: z.enum(["true", "false"]).optional(),
      E2B_API_KEY: requiredWhen(e2bEnabled),
      VM0_API_URL: z.string().url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
      VERCEL_URL: z.string().optional(),
      R2_ACCOUNT_ID: z.string().min(1),
      R2_ACCESS_KEY_ID: z.string().min(1),
      R2_SECRET_ACCESS_KEY: z.string().min(1),
      R2_USER_STORAGES_BUCKET_NAME: z.string().min(1),
      // S3-compatible storage overrides (MinIO, AWS S3, etc.)
      S3_ENDPOINT: z.string().url().optional(),
      S3_REGION: z.string().min(1).optional(),
      S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
      // Public S3 endpoint for presigned URLs (reachable from CLI / browsers)
      S3_PUBLIC_ENDPOINT: z.string().url().optional(),
      SECRETS_ENCRYPTION_KEY: z.string().length(64), // 32-byte hex key for AES-256
      OFFICIAL_RUNNER_SECRET: z.string().length(64).optional(), // 32-byte hex key for official runner auth
      AXIOM_TOKEN_SESSIONS: z.string().min(1).optional(), // Scoped token for agent-run-events
      AXIOM_TOKEN_TELEMETRY: z.string().min(1).optional(), // Scoped token for all other datasets
      AXIOM_DATASET_SUFFIX: z.enum(["dev", "prod"]).optional(), // Explicit control for Axiom dataset suffix
      SLACK_INTEGRATION_ENABLED: z.enum(["true", "false"]).optional(),
      SLACK_CLIENT_ID: requiredWhen(slackEnabled),
      SLACK_CLIENT_SECRET: requiredWhen(slackEnabled),
      SLACK_SIGNING_SECRET: requiredWhen(slackEnabled),
      SLACK_REDIRECT_BASE_URL: requiredWhen(slackEnabled, z.string().url()), // Override base URL for OAuth redirects (e.g., tunnel URL)
      SLACK_DEFAULT_AGENT: z.string().min(1).optional(), // Default agent for new installs (format: "scope/name")
      // LLM API
      OPENROUTER_API_KEY: z.string().min(1).optional(), // OpenRouter API key for logged-in users
      // GitHub OAuth (for connector)
      GH_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      GH_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Notion OAuth (for connector)
      NOTION_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      NOTION_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Platform UI URL (for settings page links in error messages)
      PLATFORM_URL: z.string().url().optional(),
      // Sentry
      SENTRY_DSN: z.string().url().optional(),
      SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
      SENTRY_ORG: z.string().min(1).optional(),
      SENTRY_PROJECT: z.string().min(1).optional(),
      // Run concurrency (0 = no limit, undefined = default of 1)
      CONCURRENT_RUN_LIMIT: z.coerce.number().int().nonnegative().optional(),
    },
    client: {
      NEXT_PUBLIC_SELF_HOSTED: z.enum(["true", "false"]).optional(),
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: requiredWhen(!isSelfHosted),
      NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      DB_POOL_MAX: process.env.DB_POOL_MAX,
      DB_POOL_IDLE_TIMEOUT_MS: process.env.DB_POOL_IDLE_TIMEOUT_MS,
      DB_POOL_CONNECT_TIMEOUT_MS: process.env.DB_POOL_CONNECT_TIMEOUT_MS,
      SELF_HOSTED: process.env.SELF_HOSTED,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      E2B_ENABLED: process.env.E2B_ENABLED,
      E2B_API_KEY: process.env.E2B_API_KEY,
      VM0_API_URL: process.env.VM0_API_URL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      R2_USER_STORAGES_BUCKET_NAME: process.env.R2_USER_STORAGES_BUCKET_NAME,
      S3_ENDPOINT: process.env.S3_ENDPOINT,
      S3_REGION: process.env.S3_REGION,
      S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
      S3_PUBLIC_ENDPOINT:
        process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
      SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
      OFFICIAL_RUNNER_SECRET: process.env.OFFICIAL_RUNNER_SECRET,
      AXIOM_TOKEN_SESSIONS: process.env.AXIOM_TOKEN_SESSIONS,
      AXIOM_TOKEN_TELEMETRY: process.env.AXIOM_TOKEN_TELEMETRY,
      AXIOM_DATASET_SUFFIX: process.env.AXIOM_DATASET_SUFFIX,
      SLACK_INTEGRATION_ENABLED: process.env.SLACK_INTEGRATION_ENABLED,
      SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
      SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
      SLACK_REDIRECT_BASE_URL: process.env.SLACK_REDIRECT_BASE_URL,
      SLACK_DEFAULT_AGENT: process.env.SLACK_DEFAULT_AGENT,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GH_OAUTH_CLIENT_ID: process.env.GH_OAUTH_CLIENT_ID,
      GH_OAUTH_CLIENT_SECRET: process.env.GH_OAUTH_CLIENT_SECRET,
      NOTION_OAUTH_CLIENT_ID: process.env.NOTION_OAUTH_CLIENT_ID,
      NOTION_OAUTH_CLIENT_SECRET: process.env.NOTION_OAUTH_CLIENT_SECRET,
      PLATFORM_URL: process.env.PLATFORM_URL,
      SENTRY_DSN: process.env.SENTRY_DSN,
      SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
      CONCURRENT_RUN_LIMIT: process.env.CONCURRENT_RUN_LIMIT,
      NEXT_PUBLIC_SELF_HOSTED: process.env.SELF_HOSTED,
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
