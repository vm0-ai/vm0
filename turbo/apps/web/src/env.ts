import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

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
      DATABASE_URL: z.string().min(1).optional(),
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
      CLERK_SECRET_KEY: z.string().min(1),
      E2B_API_KEY: z.string().min(1).optional(),
      VM0_API_URL: z.url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
      R2_ACCOUNT_ID: z.string().min(1),
      R2_ACCESS_KEY_ID: z.string().min(1),
      R2_SECRET_ACCESS_KEY: z.string().min(1),
      R2_USER_STORAGES_BUCKET_NAME: z.string().min(1),
      // S3-compatible storage overrides (MinIO, AWS S3, etc.)
      S3_ENDPOINT: z.url().optional(),
      S3_REGION: z.string().min(1).optional(),
      S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
      // Public S3 endpoint for presigned URLs (reachable from CLI / browsers)
      S3_PUBLIC_ENDPOINT: z.url().optional(),
      SECRETS_ENCRYPTION_KEY: z.string().length(64), // 32-byte hex key for AES-256
      OFFICIAL_RUNNER_SECRET: z.string().length(64).optional(), // 32-byte hex key for official runner auth
      RUNNER_DEFAULT_GROUP: z.string().min(1).optional(), // Default runner group for domain-based rollout (e.g. "vm0/production")
      GITHUB_SKILL_DOWNLOAD_TOKEN: z.string().min(1).optional(), // GitHub PAT for skill download via Contents API (avoids 60 req/hr rate limit)
      AXIOM_TOKEN_SESSIONS: z.string().min(1).optional(), // Scoped token for agent-run-events
      AXIOM_TOKEN_TELEMETRY: z.string().min(1).optional(), // Scoped token for all other datasets
      AXIOM_DATASET_SUFFIX: z.enum(["dev", "prod"]).optional(), // Explicit control for Axiom dataset suffix
      // Google Search Console verification
      GOOGLE_SITE_VERIFICATION: z.string().min(1).optional(),
      SLACK_INTEGRATION_ENABLED: z.enum(["true", "false"]).optional(),
      SLACK_CLIENT_ID: z.string().min(1).optional(),
      SLACK_CLIENT_SECRET: z.string().min(1).optional(),
      SLACK_SIGNING_SECRET: z.string().min(1).optional(),
      VM0_DEFAULT_AGENT: z.string().min(1).optional(), // Default agent compose/agent UUID for new integrations
      // Ahrefs OAuth (for connector)
      AHREFS_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      AHREFS_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Airtable OAuth (for connector)
      AIRTABLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      AIRTABLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // GitHub OAuth (for connector)
      GH_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      GH_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Notion OAuth (for connector)
      NOTION_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      NOTION_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Google OAuth (shared across all Google connectors: Gmail, Calendar, Drive, etc.)
      GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Microsoft OAuth (shared across all Microsoft connectors: Outlook Calendar, etc.)
      MICROSOFT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // HubSpot OAuth (for connector)
      HUBSPOT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      HUBSPOT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Close OAuth (for connector)
      CLOSE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      CLOSE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Deel OAuth (for connector)
      DEEL_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      DEEL_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // DocuSign OAuth (for connector)
      DOCUSIGN_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      DOCUSIGN_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Dropbox OAuth (for connector)
      DROPBOX_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      DROPBOX_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Linear OAuth (for connector)
      LINEAR_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      LINEAR_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Figma OAuth (for connector)
      FIGMA_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      FIGMA_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Mercury OAuth (for connector)
      MERCURY_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      MERCURY_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Neon OAuth (for connector)
      NEON_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      NEON_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Reddit OAuth (for connector)
      REDDIT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      REDDIT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Spotify OAuth (for connector)
      SPOTIFY_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      SPOTIFY_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Strava OAuth (for connector)
      STRAVA_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      STRAVA_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Stripe Billing (platform subscription billing — separate from the Stripe connector)
      STRIPE_SECRET_KEY: z.string().min(1).optional(),
      STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
      ZERO_PRICE: z
        .string()
        .optional()
        .transform((val) => {
          if (!val) return undefined;
          return z
            .record(z.string(), z.array(z.string()))
            .parse(JSON.parse(val));
        }),
      // Clerk Webhooks
      CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
      // Stripe OAuth (for connector)
      STRIPE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      STRIPE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Garmin Connect OAuth (for connector)
      GARMIN_CONNECT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      GARMIN_CONNECT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // X OAuth (for connector)
      X_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      X_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Vercel OAuth (for connector)
      VERCEL_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      VERCEL_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      VERCEL_INTEGRATION_SLUG: z.string().min(1).optional(),
      // Asana OAuth (for connector)
      ASANA_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      ASANA_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Sentry OAuth (for connector)
      SENTRY_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      SENTRY_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Intervals.icu OAuth (for connector)
      INTERVALS_ICU_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      INTERVALS_ICU_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Xero OAuth (for connector)
      XERO_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      XERO_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Todoist OAuth (for connector)
      TODOIST_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      TODOIST_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Monday.com OAuth (for connector)
      MONDAY_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      MONDAY_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      MONDAY_OAUTH_APP_ID: z.string().min(1).optional(),
      // Meta Ads OAuth (for connector)
      META_ADS_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      META_ADS_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // PostHog OAuth (for connector)
      POSTHOG_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      POSTHOG_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Canva OAuth (for connector)
      CANVA_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      CANVA_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Supabase OAuth (for connector)
      SUPABASE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      SUPABASE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // Webflow OAuth (for connector)
      WEBFLOW_OAUTH_CLIENT_ID: z.string().min(1).optional(),
      WEBFLOW_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
      // GitHub App (for issue integration)
      GITHUB_APP_ID: z.string().min(1).optional(),
      GITHUB_APP_SLUG: z.string().min(1).optional(),
      GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(), // Base64-encoded PEM private key
      GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
      // ngrok (for computer connector)
      NGROK_API_KEY: z.string().min(1).optional(),
      NGROK_COMPUTER_CONNECTOR_DOMAIN: z.string().min(1).optional(),
      // Email integration (Resend) — optional, only needed when email notifications are enabled
      RESEND_API_KEY: z.string().min(1).optional(),
      RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
      RESEND_FROM_DOMAIN: z.string().min(1).optional(),
      // Sentry (used by both server and client)
      SENTRY_DSN_WEB: z.url().optional(),
      SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
      SENTRY_ORG: z.string().min(1).optional(),
      SENTRY_PROJECT: z.string().min(1).optional(),
      // Run concurrency cap (0 = no limit, undefined = tier-based only)
      CONCURRENT_RUN_LIMIT_CAP: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional(),
      // Realtime pub/sub
      ABLY_API_KEY: z.string().min(1).optional(),
      // OpenAI (for voice-chat ephemeral token minting)
      OPENAI_API_KEY: z.string().min(1).optional(),
      // Vercel cron job authentication
      CRON_SECRET: z.string().min(1).optional(),
      // Lightweight model (OpenRouter) — used for internal tasks like title generation
      OPENROUTER_API_KEY: z.string().min(1).optional(),
      // Web Push (VAPID) — used for sending push notifications to PWA users
      VAPID_PUBLIC_KEY: z.string().min(1).optional(),
      VAPID_PRIVATE_KEY: z.string().min(1).optional(),
      // Dev/test flags
      USE_MOCK_CLAUDE: z.enum(["true", "false"]).optional(),
      VM0_DEBUG: z.string().optional(),
      CLAUDE_CODE_VERSION_URL: z.url().optional(),
      // Vercel platform detection
      VERCEL: z.string().optional(),
      VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
      // AgentPhone (platform-level phone channel)
      AGENTPHONE_API_KEY: z.string().min(1).optional(),
      AGENTPHONE_API_BASE_URL: z.url().optional(),
      // Plain.com (developer support thread creation) — optional, falls back to email
      PLAIN_API_KEY: z.string().min(1).optional(),
    },
    client: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
      NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),
      // Blog/content config
      NEXT_PUBLIC_BASE_URL: z.url().optional(),
      NEXT_PUBLIC_DATA_SOURCE: z.string().optional(),
      NEXT_PUBLIC_STRAPI_URL: z.url().optional(),
      // App UI URL (for settings page links, Navbar, LandingPage)
      NEXT_PUBLIC_APP_URL: z.url(),
      // Analytics (Plausible)
      NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL: z.url().optional(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      DB_POOL_MAX: process.env.DB_POOL_MAX,
      DB_POOL_IDLE_TIMEOUT_MS: process.env.DB_POOL_IDLE_TIMEOUT_MS,
      DB_POOL_CONNECT_TIMEOUT_MS: process.env.DB_POOL_CONNECT_TIMEOUT_MS,
      DB_DRIVER: process.env.DB_DRIVER,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,

      E2B_API_KEY: process.env.E2B_API_KEY,
      VM0_API_URL:
        process.env.VM0_API_URL ??
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : undefined),
      VERCEL_ENV: process.env.VERCEL_ENV,
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
      RUNNER_DEFAULT_GROUP: process.env.RUNNER_DEFAULT_GROUP,
      GITHUB_SKILL_DOWNLOAD_TOKEN: process.env.GITHUB_SKILL_DOWNLOAD_TOKEN,
      AXIOM_TOKEN_SESSIONS: process.env.AXIOM_TOKEN_SESSIONS,
      AXIOM_TOKEN_TELEMETRY: process.env.AXIOM_TOKEN_TELEMETRY,
      AXIOM_DATASET_SUFFIX: process.env.AXIOM_DATASET_SUFFIX,
      GOOGLE_SITE_VERIFICATION: process.env.GOOGLE_SITE_VERIFICATION,
      SLACK_INTEGRATION_ENABLED: process.env.SLACK_INTEGRATION_ENABLED,
      SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
      SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
      VM0_DEFAULT_AGENT: process.env.VM0_DEFAULT_AGENT,
      AHREFS_OAUTH_CLIENT_ID: process.env.AHREFS_OAUTH_CLIENT_ID,
      AHREFS_OAUTH_CLIENT_SECRET: process.env.AHREFS_OAUTH_CLIENT_SECRET,
      AIRTABLE_OAUTH_CLIENT_ID: process.env.AIRTABLE_OAUTH_CLIENT_ID,
      AIRTABLE_OAUTH_CLIENT_SECRET: process.env.AIRTABLE_OAUTH_CLIENT_SECRET,
      GH_OAUTH_CLIENT_ID: process.env.GH_OAUTH_CLIENT_ID,
      GH_OAUTH_CLIENT_SECRET: process.env.GH_OAUTH_CLIENT_SECRET,
      NOTION_OAUTH_CLIENT_ID: process.env.NOTION_OAUTH_CLIENT_ID,
      NOTION_OAUTH_CLIENT_SECRET: process.env.NOTION_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      MICROSOFT_OAUTH_CLIENT_ID: process.env.MICROSOFT_OAUTH_CLIENT_ID,
      MICROSOFT_OAUTH_CLIENT_SECRET: process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
      HUBSPOT_OAUTH_CLIENT_ID: process.env.HUBSPOT_OAUTH_CLIENT_ID,
      HUBSPOT_OAUTH_CLIENT_SECRET: process.env.HUBSPOT_OAUTH_CLIENT_SECRET,
      CLOSE_OAUTH_CLIENT_ID: process.env.CLOSE_OAUTH_CLIENT_ID,
      CLOSE_OAUTH_CLIENT_SECRET: process.env.CLOSE_OAUTH_CLIENT_SECRET,
      DEEL_OAUTH_CLIENT_ID: process.env.DEEL_OAUTH_CLIENT_ID,
      DEEL_OAUTH_CLIENT_SECRET: process.env.DEEL_OAUTH_CLIENT_SECRET,
      DOCUSIGN_OAUTH_CLIENT_ID: process.env.DOCUSIGN_OAUTH_CLIENT_ID,
      DOCUSIGN_OAUTH_CLIENT_SECRET: process.env.DOCUSIGN_OAUTH_CLIENT_SECRET,
      DROPBOX_OAUTH_CLIENT_ID: process.env.DROPBOX_OAUTH_CLIENT_ID,
      DROPBOX_OAUTH_CLIENT_SECRET: process.env.DROPBOX_OAUTH_CLIENT_SECRET,
      LINEAR_OAUTH_CLIENT_ID: process.env.LINEAR_OAUTH_CLIENT_ID,
      LINEAR_OAUTH_CLIENT_SECRET: process.env.LINEAR_OAUTH_CLIENT_SECRET,
      FIGMA_OAUTH_CLIENT_ID: process.env.FIGMA_OAUTH_CLIENT_ID,
      FIGMA_OAUTH_CLIENT_SECRET: process.env.FIGMA_OAUTH_CLIENT_SECRET,
      MERCURY_OAUTH_CLIENT_ID: process.env.MERCURY_OAUTH_CLIENT_ID,
      MERCURY_OAUTH_CLIENT_SECRET: process.env.MERCURY_OAUTH_CLIENT_SECRET,
      NEON_OAUTH_CLIENT_ID: process.env.NEON_OAUTH_CLIENT_ID,
      NEON_OAUTH_CLIENT_SECRET: process.env.NEON_OAUTH_CLIENT_SECRET,
      REDDIT_OAUTH_CLIENT_ID: process.env.REDDIT_OAUTH_CLIENT_ID,
      REDDIT_OAUTH_CLIENT_SECRET: process.env.REDDIT_OAUTH_CLIENT_SECRET,
      SPOTIFY_OAUTH_CLIENT_ID: process.env.SPOTIFY_OAUTH_CLIENT_ID,
      SPOTIFY_OAUTH_CLIENT_SECRET: process.env.SPOTIFY_OAUTH_CLIENT_SECRET,
      STRAVA_OAUTH_CLIENT_ID: process.env.STRAVA_OAUTH_CLIENT_ID,
      STRAVA_OAUTH_CLIENT_SECRET: process.env.STRAVA_OAUTH_CLIENT_SECRET,
      POSTHOG_OAUTH_CLIENT_ID: process.env.POSTHOG_OAUTH_CLIENT_ID,
      POSTHOG_OAUTH_CLIENT_SECRET: process.env.POSTHOG_OAUTH_CLIENT_SECRET,
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      ZERO_PRICE: process.env.ZERO_PRICE,
      CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
      STRIPE_OAUTH_CLIENT_ID: process.env.STRIPE_OAUTH_CLIENT_ID,
      STRIPE_OAUTH_CLIENT_SECRET: process.env.STRIPE_OAUTH_CLIENT_SECRET,
      GARMIN_CONNECT_OAUTH_CLIENT_ID:
        process.env.GARMIN_CONNECT_OAUTH_CLIENT_ID,
      GARMIN_CONNECT_OAUTH_CLIENT_SECRET:
        process.env.GARMIN_CONNECT_OAUTH_CLIENT_SECRET,
      X_OAUTH_CLIENT_ID: process.env.X_OAUTH_CLIENT_ID,
      X_OAUTH_CLIENT_SECRET: process.env.X_OAUTH_CLIENT_SECRET,
      VERCEL_OAUTH_CLIENT_ID: process.env.VERCEL_OAUTH_CLIENT_ID,
      VERCEL_OAUTH_CLIENT_SECRET: process.env.VERCEL_OAUTH_CLIENT_SECRET,
      VERCEL_INTEGRATION_SLUG: process.env.VERCEL_INTEGRATION_SLUG,
      ASANA_OAUTH_CLIENT_ID: process.env.ASANA_OAUTH_CLIENT_ID,
      ASANA_OAUTH_CLIENT_SECRET: process.env.ASANA_OAUTH_CLIENT_SECRET,
      SENTRY_OAUTH_CLIENT_ID: process.env.SENTRY_OAUTH_CLIENT_ID,
      SENTRY_OAUTH_CLIENT_SECRET: process.env.SENTRY_OAUTH_CLIENT_SECRET,
      INTERVALS_ICU_OAUTH_CLIENT_ID: process.env.INTERVALS_ICU_OAUTH_CLIENT_ID,
      INTERVALS_ICU_OAUTH_CLIENT_SECRET:
        process.env.INTERVALS_ICU_OAUTH_CLIENT_SECRET,
      XERO_OAUTH_CLIENT_ID: process.env.XERO_OAUTH_CLIENT_ID,
      XERO_OAUTH_CLIENT_SECRET: process.env.XERO_OAUTH_CLIENT_SECRET,
      MONDAY_OAUTH_CLIENT_ID: process.env.MONDAY_OAUTH_CLIENT_ID,
      MONDAY_OAUTH_CLIENT_SECRET: process.env.MONDAY_OAUTH_CLIENT_SECRET,
      MONDAY_OAUTH_APP_ID: process.env.MONDAY_OAUTH_APP_ID,
      META_ADS_OAUTH_CLIENT_ID: process.env.META_ADS_OAUTH_CLIENT_ID,
      META_ADS_OAUTH_CLIENT_SECRET: process.env.META_ADS_OAUTH_CLIENT_SECRET,
      CANVA_OAUTH_CLIENT_ID: process.env.CANVA_OAUTH_CLIENT_ID,
      CANVA_OAUTH_CLIENT_SECRET: process.env.CANVA_OAUTH_CLIENT_SECRET,
      SUPABASE_OAUTH_CLIENT_ID: process.env.SUPABASE_OAUTH_CLIENT_ID,
      SUPABASE_OAUTH_CLIENT_SECRET: process.env.SUPABASE_OAUTH_CLIENT_SECRET,
      TODOIST_OAUTH_CLIENT_ID: process.env.TODOIST_OAUTH_CLIENT_ID,
      TODOIST_OAUTH_CLIENT_SECRET: process.env.TODOIST_OAUTH_CLIENT_SECRET,
      WEBFLOW_OAUTH_CLIENT_ID: process.env.WEBFLOW_OAUTH_CLIENT_ID,
      WEBFLOW_OAUTH_CLIENT_SECRET: process.env.WEBFLOW_OAUTH_CLIENT_SECRET,
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
      NGROK_API_KEY: process.env.NGROK_API_KEY,
      NGROK_COMPUTER_CONNECTOR_DOMAIN:
        process.env.NGROK_COMPUTER_CONNECTOR_DOMAIN,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
      RESEND_FROM_DOMAIN: process.env.RESEND_FROM_DOMAIN,
      SENTRY_DSN_WEB: process.env.SENTRY_DSN_WEB,
      SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
      CONCURRENT_RUN_LIMIT_CAP: process.env.CONCURRENT_RUN_LIMIT_CAP,
      ABLY_API_KEY: process.env.ABLY_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CRON_SECRET: process.env.CRON_SECRET,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
      USE_MOCK_CLAUDE: process.env.USE_MOCK_CLAUDE,
      VM0_DEBUG: process.env.VM0_DEBUG,
      CLAUDE_CODE_VERSION_URL: process.env.CLAUDE_CODE_VERSION_URL,
      VERCEL: process.env.VERCEL,
      VERCEL_AUTOMATION_BYPASS_SECRET:
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      AGENTPHONE_API_KEY: process.env.AGENTPHONE_API_KEY,
      AGENTPHONE_API_BASE_URL: process.env.AGENTPHONE_API_BASE_URL,
      PLAIN_API_KEY: process.env.PLAIN_API_KEY,

      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
      NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
      NEXT_PUBLIC_DATA_SOURCE: process.env.NEXT_PUBLIC_DATA_SOURCE,
      NEXT_PUBLIC_STRAPI_URL: process.env.NEXT_PUBLIC_STRAPI_URL,
      NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL:
        process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL,
    },
    emptyStringAsUndefined: true,
  });

  // Post-validation conditional checks
  // These validate relationships between environment variables after schema parsing
  // Only run on server-side where all env vars are accessible
  const isServer = typeof window === "undefined";

  if (isServer) {
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
