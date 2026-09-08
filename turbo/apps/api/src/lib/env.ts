import { createEnv } from "@t3-oss/env-core";
import { z, type ZodType } from "zod";

import { testOverride } from "./singleton";

const priceIdsSchema = z
  .string()
  .optional()
  .transform((value) => {
    return value
      ?.split(",")
      .map((priceId) => {
        return priceId.trim();
      })
      .filter((priceId) => {
        return priceId.length > 0;
      });
  });

const SCHEMA = {
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  SECRETS_ENCRYPTION_KEY: z.string().length(64),
  SECRETS_KMS_KEY_ID: z.string().min(1).optional(),
  OFFICIAL_RUNNER_SECRET: z.string().length(64),
  OPENAI_API_KEY: z.string().min(1),
  FAL_KEY: z.string().min(1).optional(),
  JOGGAI_API_KEY: z.string().min(1).optional(),
  JOGGAI_WEBHOOK_SECRET: z.string().min(1).optional(),
  HEYGEN_API_KEY: z.string().min(1).optional(),
  BYTEPLUS_API_KEY: z.string().min(1).optional(),
  MINIMAX_API_KEY: z.string().min(1).optional(),
  BYTEPLUS_STT_API_KEY: z.string().min(1).optional(),
  OKOU_MAPS_GOOGLE_MAPS_TOKEN: z.string().min(1).optional(),
  OKOU_WEATHER_GOOGLE_WEATHER_TOKEN: z.string().min(1).optional(),
  OKOU_SCRAPE_FIRECRAWL_TOKEN: z.string().min(1).optional(),
  OKOU_WEB_SEARCH_PERPLEXITY_TOKEN: z.string().min(1).optional(),
  OKOU_SOCIAL_SOCIALKIT_TOKEN: z.string().min(1).optional(),
  OKOU_FINANCE_APIDOJO_TOKEN: z.string().min(1).optional(),
  OKOU_SEO_DATAFORSEO_LOGIN: z.string().min(1).optional(),
  OKOU_SEO_DATAFORSEO_PASSWORD: z.string().min(1).optional(),
  OKOU_BROWSER_USE_API_KEY: z.string().min(1).optional(),
  STEAM_WEB_API_KEY: z.string().min(1).optional(),
  FINICITY_APP_KEY: z.string().min(1).optional(),
  FINICITY_APP_SECRET: z.string().min(1).optional(),
  FINICITY_PARTNER_ID: z.string().min(1).optional(),
  FINICITY_WEBHOOK_BASE_URL: z.url().optional(),
  SENTRY_DSN: z.url().optional(),
  GIT_COMMIT_SHA: z.string(),
  ENV: z.enum(["production", "preview", "development"]),
  VITEST: z.enum(["true", "false"]).default("false"),
  OKOU_DEBUG: z.string().default(""),
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().min(1).optional(),
  // Direct origin of the API backend for self-dispatched internal callbacks
  // (`/api/internal/**`). Optional; when unset, production defaults to the API
  // backend origin and other environments fall back to the configured web URL.
  OKOU_API_BACKEND_URL: z.url().optional(),
  FEISHU_CALLBACK_BASE_URL: z.url(),
  OKOU_WEB_URL: z.url(),
  APP_URL: z.url(),
  CLI_PKG_URL: z.url(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  RESEND_FROM_DOMAIN: z.string().min(1).optional(),
  GMAIL_PUBSUB_TOPIC_NAME: z.string().min(1).optional(),
  GMAIL_PUBSUB_PUSH_AUDIENCE: z.url().optional(),
  GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: z.email().optional(),
  GOOGLE_FORMS_PUBSUB_TOPIC_NAME: z.string().min(1).optional(),
  GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE: z.url().optional(),
  GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: z.email().optional(),
  GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME: z.string().min(1).optional(),
  GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE: z.url().optional(),
  GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: z
    .email()
    .optional(),
  CRON_SECRET: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_USER_STORAGES_BUCKET_NAME: z.string().min(1),
  R2_USER_ARTIFACTS_BUCKET_NAME: z.string().min(1),
  R2_USER_ARTIFACTS_ACCESS_KEY_ID: z.string().min(1),
  R2_USER_ARTIFACTS_SECRET_ACCESS_KEY: z.string().min(1),
  PUBLIC_ARTIFACTS_BASE_URL: z.url(),
  OKOU_PUBLIC_ARTIFACTS_BASE_URL: z.url(),
  R2_HOSTED_SITES_BUCKET_NAME: z.string().min(1).optional(),
  R2_HOSTED_SITES_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_HOSTED_SITES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  CLOUDFLARE_BROWSER_RENDERING_API_TOKEN: z.string().min(1).optional(),
  ARTIFACT_PREVIEW_WAF_SECRET: z.string().min(32).optional(),
  OKOU_PUBLIC_HOST_DOMAIN: z.string().min(1),
  // ZERO_HOST_DOMAIN and ZERO_HOST_SCHEME are not legacy aliases waiting to be
  // drained. Here the ZERO_ prefix marks which brand a value belongs to, and
  // both brands are live at the same time: host.service.ts picks the domain and
  // scheme per request from the public brand, and artifact-preview.service.ts
  // accepts both domains. These two hold the VM0-brand hosted-site
  // configuration (sites.vm0.io); removing them breaks every VM0-brand hosted
  // site URL. They retire with the VM0-brand host under #26701, not with the
  // rest of the ZERO_* variables.
  ZERO_HOST_DOMAIN: z.string().min(1).default("sites.vm0.io"),
  OKOU_HOST_SCHEME: z.enum(["http", "https"]).optional(),
  // Brand-scoped live configuration, same as ZERO_HOST_DOMAIN above. It also
  // serves as the one remaining OKOU_ENV_FALLBACKS source, for
  // OKOU_HOST_SCHEME.
  ZERO_HOST_SCHEME: z.enum(["http", "https"]).default("https"),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  AXIOM_TOKEN_SESSIONS: z.string().min(1),
  AXIOM_TOKEN_TELEMETRY: z.string().min(1),
  AXIOM_DATASET_SUFFIX: z.enum(["dev", "prod"]),
  STRIPE_SECRET_KEY: z.string().min(1),
  ATOM_URL: z.url().optional(),
  ATOM_GRANT_PRICE: z.string().min(1).optional(),
  OKOU_PRICE_PRO: priceIdsSchema,
  OKOU_PRICE_TEAM: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_PLAN_PRO: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_PLAN_TEAM: priceIdsSchema,
  OKOU_PRICE_CUSTOM: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_20: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_50: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_100: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_200: priceIdsSchema,
  OKOU_PRICE_CUSTOM_CREDIT_UNIT: z.string().min(1).optional(),
  OKOU_PRICE_CONCURRENCY: priceIdsSchema,
  OKOU_ONE_TIME_CAMPAIGN: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) {
        return undefined;
      }
      return z
        .record(
          z.string(),
          z.object({ priceId: z.string(), couponId: z.string() }),
        )
        .parse(JSON.parse(val));
    }),
  ABLY_API_KEY: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(5000),
  DB_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
  TELEGRAM_OFFICIAL_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OFFICIAL_BOT_USERNAME: z.string().optional(),
  TELEGRAM_OFFICIAL_WEBHOOK_SECRET: z.string().optional(),
  SLACK_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_TEAMS_BOT_APP_ID: z.string().min(1).optional(),
  MICROSOFT_TEAMS_BOT_APP_PASSWORD: z.string().min(1).optional(),
  MICROSOFT_TEAMS_APP_TENANT_ID: z.string().min(1).optional(),
  CONCURRENT_RUN_LIMIT_CAP: z.coerce.number().int().min(0).optional(),
  PI_MEMORY_STAGE1_IDLE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(30 * 60 * 1000),
  PI_MEMORY_BACKGROUND_WORKERS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
} as const;

const baseEnv = createEnv<undefined, typeof SCHEMA>({
  server: SCHEMA,
  runtimeEnv: {
    ...process.env,
    S3_PUBLIC_ENDPOINT:
      process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
  },
  emptyStringAsUndefined: true,
});

type EnvShape = typeof baseEnv;
type EnvName = keyof EnvShape;

const OKOU_ENV_FALLBACKS = {
  OKOU_HOST_SCHEME: "ZERO_HOST_SCHEME",
} as const satisfies Partial<Record<EnvName, EnvName>>;

type OkouEnvName = keyof typeof OKOU_ENV_FALLBACKS;
type RequiredOkouEnvName = "OKOU_HOST_SCHEME";

const {
  get: getOverrideEnv,
  set: setOverrideEnv,
  clear: clearOverrideEnv,
} = testOverride<Partial<EnvShape>>(() => {
  return {};
});

const {
  get: getOptionalOverrideEnv,
  set: setOptionalOverrideEnv,
  clear: clearOptionalOverrideEnv,
} = testOverride<Readonly<Record<string, string | undefined>>>(() => {
  return {};
});

function readEnv<K extends EnvName>(name: K): EnvShape[K] {
  const overrideEnv = getOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name] as EnvShape[K];
  }
  return baseEnv[name];
}

function isOkouEnvName(name: EnvName): name is OkouEnvName {
  return Object.prototype.hasOwnProperty.call(OKOU_ENV_FALLBACKS, name);
}

export function env<K extends RequiredOkouEnvName>(
  name: K,
): NonNullable<EnvShape[K]>;
export function env<K extends EnvName>(name: K): EnvShape[K];
export function env<K extends EnvName>(name: K): EnvShape[K] {
  const value = readEnv(name);
  if (value !== undefined || !isOkouEnvName(name)) {
    return value;
  }
  return readEnv(OKOU_ENV_FALLBACKS[name]) as EnvShape[K];
}

export function optionalEnv(name: string): string | undefined {
  const overrideEnv = getOptionalOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name];
  }
  return process.env[name] || undefined;
}

export function mockEnv<K extends EnvName>(
  name: K,
  value: z.input<(typeof SCHEMA)[K]>,
): void {
  const schema = SCHEMA[name] as ZodType;
  setOverrideEnv({
    ...getOverrideEnv(),
    [name]: schema.parse(value) as EnvShape[K],
  });
}

export function mockOptionalEnv(name: string, value: string | undefined): void {
  setOptionalOverrideEnv({
    ...getOptionalOverrideEnv(),
    [name]: value,
  });
}

export function clearMockedEnv(): void {
  clearOverrideEnv();
  clearOptionalOverrideEnv();
}
