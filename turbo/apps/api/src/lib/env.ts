import { createEnv } from "@t3-oss/env-core";
import { z, type ZodType } from "zod";

import { testOverride } from "./singleton";

const SCHEMA = {
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  SECRETS_ENCRYPTION_KEY: z.string().length(64),
  SECRETS_KMS_KEY_ID: z.string().min(1).optional(),
  OFFICIAL_RUNNER_SECRET: z.string().length(64),
  OPENAI_API_KEY: z.string().min(1),
  FAL_KEY: z.string().min(1).optional(),
  ZERO_MAPS_GOOGLE_MAPS_TOKEN: z.string().min(1).optional(),
  SENTRY_DSN: z.url().optional(),
  GIT_COMMIT_SHA: z.string(),
  ENV: z.enum(["production", "preview", "development"]),
  VITEST: z.enum(["true", "false"]).default("false"),
  VM0_DEBUG: z.string().default(""),
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().min(1).optional(),
  VM0_API_URL: z.url(),
  VM0_WEB_URL: z.url(),
  APP_URL: z.url(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  RESEND_FROM_DOMAIN: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_USER_STORAGES_BUCKET_NAME: z.string().min(1),
  R2_USER_ARTIFACTS_BUCKET_NAME: z.string().min(1),
  R2_USER_ARTIFACTS_ACCESS_KEY_ID: z.string().min(1),
  R2_USER_ARTIFACTS_SECRET_ACCESS_KEY: z.string().min(1),
  PUBLIC_ARTIFACTS_BASE_URL: z.url(),
  R2_HOSTED_SITES_BUCKET_NAME: z.string().min(1).optional(),
  R2_HOSTED_SITES_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_HOSTED_SITES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  ZERO_HOST_DOMAIN: z.string().min(1).default("sites.vm0.io"),
  ZERO_HOST_SCHEME: z.enum(["http", "https"]).default("https"),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  AXIOM_TOKEN_SESSIONS: z.string().min(1),
  AXIOM_TOKEN_TELEMETRY: z.string().min(1),
  AXIOM_DATASET_SUFFIX: z.enum(["dev", "prod"]),
  STRIPE_SECRET_KEY: z.string().min(1),
  ZERO_PRICE: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) {
        return undefined;
      }
      return z.record(z.string(), z.array(z.string())).parse(JSON.parse(val));
    }),
  ZERO_ONE_TIME_CAMPAIGN: z
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
  SLACK_CLIENT_ID: z.string().optional(),
  // Gemini via Vertex AI (Vercel OIDC -> GCP Workload Identity Federation).
  // Production should use the GCP_* vars; dev/test may use GEMINI_API_KEY.
  GCP_PROJECT_ID: z.string().min(1).optional(),
  GCP_PROJECT_NUMBER: z.string().min(1).optional(),
  GCP_SERVICE_ACCOUNT_EMAIL: z.string().min(1).optional(),
  GCP_WORKLOAD_IDENTITY_POOL_ID: z.string().min(1).optional(),
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  CONCURRENT_RUN_LIMIT_CAP: z.coerce.number().int().min(0).optional(),
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
type EnvKey = keyof EnvShape;

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

export function env<K extends EnvKey>(name: K): EnvShape[K] {
  const overrideEnv = getOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name] as EnvShape[K];
  }
  return baseEnv[name];
}

export function optionalEnv(name: string): string | undefined {
  const overrideEnv = getOptionalOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name];
  }
  return process.env[name] || undefined;
}

export function mockEnv<K extends EnvKey>(
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
