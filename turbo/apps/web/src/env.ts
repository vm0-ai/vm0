import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Whether Clerk authentication is configured.
 *
 * Derived from the presence of NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.
 * When false, the app falls back to single-user local auth.
 *
 * Uses a NEXT_PUBLIC_* var so Next.js auto-inlines it at build time,
 * making it work in both Server and Client Components.
 *
 * Does NOT trigger full env() validation, safe for use in layout.tsx
 * and other build-time evaluated Server Components.
 */
export function hasClerkAuth(): boolean {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

/**
 * Whether the blog feature is available.
 *
 * Derived from the presence of a Strapi URL. No Strapi = no blog.
 */
export function isBlogEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_STRAPI_URL;
}

function initEnv() {
  const env = createEnv({
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
      // Database driver selection
      // Defaults to 'neon' (optimized for serverless/Vercel)
      // Set to 'pg' for local development with standard Postgres
      DB_DRIVER: z.enum(["pg", "neon"]).default("neon"),
      CLERK_ENABLED: z.enum(["true", "false"]).optional(),
      CLERK_SECRET_KEY: z.string().min(1).optional(),
      E2B_API_KEY: z.string().min(1).optional(),
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
      SLACK_CLIENT_ID: z.string().min(1).optional(),
      SLACK_CLIENT_SECRET: z.string().min(1).optional(),
      SLACK_SIGNING_SECRET: z.string().min(1).optional(),
      SLACK_REDIRECT_BASE_URL: z.string().url().optional(), // Override base URL for OAuth redirects (e.g., tunnel URL)
      SLACK_DEFAULT_AGENT: z.string().min(1).optional(), // Default agent for new installs (format: "scope/name")
      // LLM API
      OPENROUTER_API_KEY: z.string().min(1).optional(), // OpenRouter API key for logged-in users
      // GitHub OAuth (for connector)
      GH_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      GH_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Notion OAuth (for connector)
      NOTION_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      NOTION_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // ngrok (for computer connector)
      NGROK_API_KEY: z.string().min(1).optional(),
      NGROK_COMPUTER_CONNECTOR_DOMAIN: z.string().min(1).optional(),
      // Email integration (Resend) — optional, only needed when email notifications are enabled
      RESEND_API_KEY: z.string().min(1).optional(),
      RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
      RESEND_FROM_DOMAIN: z.string().min(1).optional(),
      // Sentry
      SENTRY_DSN: z.string().url().optional(),
      SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
      SENTRY_ORG: z.string().min(1).optional(),
      SENTRY_PROJECT: z.string().min(1).optional(),
      // Run concurrency (0 = no limit, undefined = default of 1)
      CONCURRENT_RUN_LIMIT: z.coerce.number().int().nonnegative().optional(),
      // Realtime pub/sub
      ABLY_API_KEY: z.string().min(1).optional(),
      // Vercel cron job authentication
      CRON_SECRET: z.string().min(1).optional(),
      // Dev/test flags
      USE_MOCK_CLAUDE: z.enum(["true", "false"]).optional(),
      VM0_DEBUG: z.string().optional(),
      CLAUDE_CODE_VERSION_URL: z.string().url().optional(),
      // Docker sandbox config
      DOCKER_NETWORK: z.string().optional(),
      DOCKER_SANDBOX_IMAGE: z.string().optional(),
      DOCKER_SANDBOX_MEMORY: z.string().optional(),
      DOCKER_SANDBOX_CPUS: z.string().optional(),
      // Vercel platform detection
      VERCEL: z.string().optional(),
      VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
    },
    client: {
      NEXT_PUBLIC_CLERK_ENABLED: z.enum(["true", "false"]).optional(),
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
      NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
      // Blog/content config
      NEXT_PUBLIC_BASE_URL: z.string().url().optional(),
      NEXT_PUBLIC_DATA_SOURCE: z.string().optional(),
      NEXT_PUBLIC_STRAPI_URL: z.string().url().optional(),
      // Platform UI URL (for settings page links, Navbar, LandingPage)
      NEXT_PUBLIC_PLATFORM_URL: z.string().url(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      DB_POOL_MAX: process.env.DB_POOL_MAX,
      DB_POOL_IDLE_TIMEOUT_MS: process.env.DB_POOL_IDLE_TIMEOUT_MS,
      DB_POOL_CONNECT_TIMEOUT_MS: process.env.DB_POOL_CONNECT_TIMEOUT_MS,
      DB_DRIVER: process.env.DB_DRIVER,
      CLERK_ENABLED: process.env.CLERK_ENABLED,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,

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
      NGROK_API_KEY: process.env.NGROK_API_KEY,
      NGROK_COMPUTER_CONNECTOR_DOMAIN:
        process.env.NGROK_COMPUTER_CONNECTOR_DOMAIN,
      NEXT_PUBLIC_PLATFORM_URL: process.env.NEXT_PUBLIC_PLATFORM_URL,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
      RESEND_FROM_DOMAIN: process.env.RESEND_FROM_DOMAIN,
      SENTRY_DSN: process.env.SENTRY_DSN,
      SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
      CONCURRENT_RUN_LIMIT: process.env.CONCURRENT_RUN_LIMIT,
      ABLY_API_KEY: process.env.ABLY_API_KEY,
      CRON_SECRET: process.env.CRON_SECRET,
      USE_MOCK_CLAUDE: process.env.USE_MOCK_CLAUDE,
      VM0_DEBUG: process.env.VM0_DEBUG,
      CLAUDE_CODE_VERSION_URL: process.env.CLAUDE_CODE_VERSION_URL,
      DOCKER_NETWORK: process.env.DOCKER_NETWORK,
      DOCKER_SANDBOX_IMAGE: process.env.DOCKER_SANDBOX_IMAGE,
      DOCKER_SANDBOX_MEMORY: process.env.DOCKER_SANDBOX_MEMORY,
      DOCKER_SANDBOX_CPUS: process.env.DOCKER_SANDBOX_CPUS,
      VERCEL: process.env.VERCEL,
      VERCEL_AUTOMATION_BYPASS_SECRET:
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET,

      NEXT_PUBLIC_CLERK_ENABLED: process.env.NEXT_PUBLIC_CLERK_ENABLED,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
      NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
      NEXT_PUBLIC_DATA_SOURCE: process.env.NEXT_PUBLIC_DATA_SOURCE,
      NEXT_PUBLIC_STRAPI_URL: process.env.NEXT_PUBLIC_STRAPI_URL,
    },
    // Skip validation during Docker build (SKIP_ENV_VALIDATION=true in Dockerfile)
    // where server env vars are unavailable at build time.
    skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
    emptyStringAsUndefined: true,
  });

  // Post-validation conditional checks
  // These validate relationships between environment variables after schema parsing

  // Clerk integration validation
  const clerkEnabledServer = env.CLERK_ENABLED === "true";
  const clerkEnabledClient = env.NEXT_PUBLIC_CLERK_ENABLED === "true";

  // Consistency check: Server and client Clerk flags should match
  if (clerkEnabledServer !== clerkEnabledClient) {
    throw new Error(
      "CLERK_ENABLED and NEXT_PUBLIC_CLERK_ENABLED must have the same value. " +
        `Currently: CLERK_ENABLED=${env.CLERK_ENABLED}, NEXT_PUBLIC_CLERK_ENABLED=${env.NEXT_PUBLIC_CLERK_ENABLED}`,
    );
  }

  if (clerkEnabledServer) {
    if (!env.CLERK_SECRET_KEY) {
      throw new Error(
        "CLERK_SECRET_KEY is required when CLERK_ENABLED=true. " +
          "Set CLERK_SECRET_KEY or remove CLERK_ENABLED to use local auth.",
      );
    }
    if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
      throw new Error(
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required when CLERK_ENABLED=true. " +
          "Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY or remove CLERK_ENABLED to use local auth.",
      );
    }
  }

  // Slack integration validation
  const slackEnabled = env.SLACK_INTEGRATION_ENABLED === "true";
  if (slackEnabled) {
    if (!env.SLACK_CLIENT_ID) {
      throw new Error(
        "SLACK_CLIENT_ID is required when SLACK_INTEGRATION_ENABLED=true",
      );
    }
    if (!env.SLACK_CLIENT_SECRET) {
      throw new Error(
        "SLACK_CLIENT_SECRET is required when SLACK_INTEGRATION_ENABLED=true",
      );
    }
    if (!env.SLACK_SIGNING_SECRET) {
      throw new Error(
        "SLACK_SIGNING_SECRET is required when SLACK_INTEGRATION_ENABLED=true",
      );
    }
    if (!env.SLACK_REDIRECT_BASE_URL) {
      throw new Error(
        "SLACK_REDIRECT_BASE_URL is required when SLACK_INTEGRATION_ENABLED=true",
      );
    }
  }

  return env;
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
