import { createEnv } from "@t3-oss/env-core";
import { z, type ZodType } from "zod";

import { testOverride } from "./singleton";

const SCHEMA = {
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  SECRETS_ENCRYPTION_KEY: z.string().length(64),
  OFFICIAL_RUNNER_SECRET: z.string().length(64),
  OPENAI_API_KEY: z.string().min(1),
  SENTRY_DSN: z.url().optional(),
  GIT_COMMIT_SHA: z.string(),
  ENV: z.enum(["production", "preview", "development"]),
  VITEST: z.enum(["true", "false"]).default("false"),
  VM0_DEBUG: z.string().default(""),
  VM0_API_URL: z.url(),
  VM0_WEB_URL: z.url(),
  CRON_SECRET: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_USER_STORAGES_BUCKET_NAME: z.string().min(1),
  AXIOM_TOKEN_SESSIONS: z.string().min(1),
  AXIOM_TOKEN_TELEMETRY: z.string().min(1),
  AXIOM_DATASET_SUFFIX: z.enum(["dev", "prod"]),
  STRIPE_SECRET_KEY: z.string().min(1),
  // Shared HMAC secret for the voice-chat realtime relay token. Hex-encoded
  // 32-byte secret (64 hex chars) — same format apps/web validates with
  // `z.string().length(64).optional()`. The mint side (apps/web, #12140) and
  // the verify side (this app's WS upgrade) MUST read the same value in
  // production. Optional in the schema so deployments that don't run the
  // relay can omit it; the relay route fails closed (WS close 1011) if unset.
  VOICE_CHAT_RELAY_TOKEN_SECRET: z.string().length(64).optional(),
} as const;

const baseEnv = createEnv<undefined, typeof SCHEMA>({
  server: SCHEMA,
  runtimeEnv: process.env,
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

export function env<K extends EnvKey>(name: K): EnvShape[K] {
  const overrideEnv = getOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name] as EnvShape[K];
  }
  return baseEnv[name];
}

export function mockEnv<K extends EnvKey>(name: K, value: EnvShape[K]): void {
  const schema = SCHEMA[name] as ZodType;
  setOverrideEnv({
    ...getOverrideEnv(),
    [name]: schema.parse(value) as EnvShape[K],
  });
}

export function clearMockedEnv(): void {
  clearOverrideEnv();
}
