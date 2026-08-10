import { Buffer } from "node:buffer";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SHARD_COUNT = 32;
const MAX_SHARD_BYTES = 4096;
const SHARD_PREFIX = "VM0_WORKER_ENV_";

const STATIC_ALLOWED_NAMES = new Set(
  `
ABLY_API_KEY AGENTPHONE_AGENT_ID AGENTPHONE_API_BASE_URL AGENTPHONE_API_KEY
AGENTPHONE_PHONE_NUMBER AGENTPHONE_WEBHOOK_SECRET APP_URL
ARTIFACT_PREVIEW_WAF_SECRET ATOM_GRANT_PRICE ATOM_URL AWS_ACCESS_KEY_ID
AWS_REGION AWS_SECRET_ACCESS_KEY AXIOM_DATASET_SUFFIX AXIOM_TOKEN_SESSIONS
AXIOM_TOKEN_TELEMETRY BLOG_BASE_URL BYTEPLUS_API_KEY BYTEPLUS_STT_API_KEY
CF_ACCOUNT_ID CLAUDE_CODE_VERSION_URL CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY
CF_ACCESS_AUD CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET CF_ACCESS_JWKS
CF_ACCESS_TEAM_DOMAIN
CLERK_WEBHOOK_SIGNING_SECRET CLI_PKG_URL CLOUDFLARE_BROWSER_RENDERING_API_TOKEN
CONCURRENT_RUN_LIMIT_CAP CRON_SECRET DATABASE_URL ENV FAL_KEY
FEISHU_CALLBACK_BASE_URL FINICITY_APP_KEY FINICITY_APP_SECRET FINICITY_PARTNER_ID
GCP_PROJECT_ID GCP_PROJECT_NUMBER GCP_SERVICE_ACCOUNT_EMAIL
GCP_WORKLOAD_IDENTITY_POOL_ID GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
GITHUB_APP_CLIENT_ID GITHUB_APP_CLIENT_SECRET GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY GITHUB_APP_SLUG GITHUB_APP_WEBHOOK_SECRET GIT_COMMIT_SHA
GMAIL_PUBSUB_PUSH_AUDIENCE GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL
GMAIL_PUBSUB_TOPIC_NAME GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_LOGIN_CUSTOMER_ID
GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL
GOOGLE_FORMS_PUBSUB_TOPIC_NAME GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE
GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL
GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME JOGGAI_API_KEY JOGGAI_WEBHOOK_SECRET
MERCURY_OAUTH_ENVIRONMENT MICROSOFT_TEAMS_APP_TENANT_ID
MICROSOFT_TEAMS_BOT_APP_ID MICROSOFT_TEAMS_BOT_APP_PASSWORD MINIMAX_API_KEY
MONDAY_OAUTH_APP_ID OFFICIAL_RUNNER_SECRET OPENAI_API_KEY OPENROUTER_API_KEY
PEXELS_API_KEY PLAIN_API_KEY PLAUSIBLE_SCRIPT_URL PUBLIC_ARTIFACTS_BASE_URL
R2_ACCESS_KEY_ID R2_ACCOUNT_ID R2_HOSTED_SITES_ACCESS_KEY_ID
R2_HOSTED_SITES_BUCKET_NAME R2_HOSTED_SITES_SECRET_ACCESS_KEY R2_SECRET_ACCESS_KEY
R2_USER_ARTIFACTS_ACCESS_KEY_ID R2_USER_ARTIFACTS_BUCKET_NAME
R2_USER_ARTIFACTS_SECRET_ACCESS_KEY R2_USER_STORAGES_BUCKET_NAME RESEND_API_KEY
RESEND_FROM_DOMAIN RESEND_WEBHOOK_SECRET RUNNER_DEFAULT_GROUP
SECRETS_ENCRYPTION_KEY SECRETS_KMS_KEY_ID SLACK_REDIRECT_BASE_URL
SLACK_SIGNING_SECRET STATIC_ASSETS_BASE_URL STEAM_WEB_API_KEY STRAPI_URL
STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID STRIPE_SECRET_KEY
STRIPE_AUTOMATION_WEBHOOK_SECRET STRIPE_WEBHOOK_SECRET TELEGRAM_OFFICIAL_BOT_TOKEN TELEGRAM_OFFICIAL_BOT_USERNAME
TELEGRAM_OFFICIAL_WEBHOOK_SECRET UNSPLASH_ACCESS_KEY USE_MOCK_CLAUDE
VAPID_PRIVATE_KEY VAPID_PUBLIC_KEY VERCEL_AUTOMATION_BYPASS_SECRET
VERCEL_INTEGRATION_SLUG VM0_API_BACKEND_URL
VM0_DEBUG VM0_DEFAULT_AGENT VM0_MACHINE_SECRET_KEY VM0_PREVIEW_JOB_REF VM0_WEB_URL
ZERO_BROWSER_USE_API_KEY ZERO_FINANCE_APIDOJO_TOKEN ZERO_HOST_DOMAIN
ZERO_HOST_SCHEME ZERO_MAPS_GOOGLE_MAPS_TOKEN ZERO_ONE_TIME_CAMPAIGN
ZERO_PRICE_CONCURRENCY ZERO_PRICE_CUSTOM_CREDITS ZERO_PRICE_CUSTOM_CREDIT_UNIT
ZERO_PRICE_PRO ZERO_PRICE_TEAM ZERO_PRICE_USAGE_PACK_100 ZERO_PRICE_USAGE_PACK_20
ZERO_PRICE_USAGE_PACK_200 ZERO_PRICE_USAGE_PACK_50 ZERO_PRICE_USAGE_PACK_PLAN_PRO
ZERO_PRICE_USAGE_PACK_PLAN_TEAM ZERO_SCRAPE_FIRECRAWL_TOKEN
ZERO_WEATHER_GOOGLE_WEATHER_TOKEN ZERO_WEB_SEARCH_PERPLEXITY_TOKEN
`
    .trim()
    .split(/\s+/u),
);

const OAUTH_PREFIXES = [
  "GH",
  "SLACK",
  "NOTION",
  "GOOGLE",
  "MICROSOFT",
  "LINEAR",
  "FIGMA",
  "DEEL",
  "DOCUSIGN",
  "DROPBOX",
  "NEON",
  "REDDIT",
  "STRAVA",
  "X",
  "VERCEL",
  "SENTRY",
  "INTERVALS_ICU",
  "SUPABASE",
  "XERO",
  "MONDAY",
  "WEBFLOW",
  "CANVA",
  "CLOUDFLARE",
  "HUBSPOT",
  "CLOSE",
  "META_ADS",
  "AHREFS",
  "AIRTABLE",
  "TODOIST",
  "ASANA",
  "POSTHOG",
  "QUICKBOOKS",
  "GUMROAD",
  "MERCURY",
  "SPOTIFY",
  "STRIPE",
];

for (const prefix of OAUTH_PREFIXES) {
  STATIC_ALLOWED_NAMES.add(`${prefix}_OAUTH_CLIENT_ID`);
  STATIC_ALLOWED_NAMES.add(`${prefix}_OAUTH_CLIENT_SECRET`);
}

const EXCLUDED_NAMES = new Set([
  "NEXT_PUBLIC_STATIC_ASSETS_BASE_URL",
  "POSTHOG_HOST",
  "POSTHOG_KEY",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_DSN",
  "SENTRY_DSN_API",
  "SENTRY_DSN_WEB",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
]);

function parseEnvironmentFile(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("Worker environment file contains an invalid line");
    }
    const name = line.slice(0, separator);
    if (values.has(name)) {
      throw new Error(`${name} is duplicated in the Worker environment file`);
    }
    values.set(name, line.slice(separator + 1));
  }
  return values;
}

function encodedBytes(entries) {
  return Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)));
}

export function buildWorkerSecrets(contents) {
  const environment = parseEnvironmentFile(contents);
  const unknown = [...environment.keys()].filter((name) => {
    return !STATIC_ALLOWED_NAMES.has(name) && !EXCLUDED_NAMES.has(name);
  });
  if (unknown.length > 0) {
    throw new Error(
      `Worker environment allowlist is missing: ${unknown.join(", ")}`,
    );
  }

  const entries = [...environment]
    .filter(([name, value]) => {
      return STATIC_ALLOWED_NAMES.has(name) && value.length > 0;
    })
    .sort((left, right) => {
      return encodedBytes([right]) - encodedBytes([left]);
    });
  const shards = Array.from({ length: SHARD_COUNT }, () => {
    return [];
  });
  for (const entry of entries) {
    let target = -1;
    let targetBytes = Number.POSITIVE_INFINITY;
    for (const [index, shard] of shards.entries()) {
      const bytes = encodedBytes([...shard, entry]);
      if (bytes <= MAX_SHARD_BYTES && bytes < targetBytes) {
        target = index;
        targetBytes = bytes;
      }
    }
    if (target === -1) {
      throw new Error(
        `Worker environment does not fit in ${SHARD_COUNT} shards`,
      );
    }
    shards[target].push(entry);
  }

  return Object.fromEntries(
    shards.map((shard, index) => {
      const name = `${SHARD_PREFIX}${String(index + 1).padStart(2, "0")}`;
      return [name, JSON.stringify(Object.fromEntries(shard))];
    }),
  );
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    throw new Error(
      "Usage: build-worker-secrets.mjs <input.env> <output.json>",
    );
  }
  const secrets = buildWorkerSecrets(fs.readFileSync(input, "utf8"));
  fs.writeFileSync(output, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
