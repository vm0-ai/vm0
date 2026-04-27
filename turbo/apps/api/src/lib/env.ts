import { createEnv } from "@t3-oss/env-core";
import { z, type ZodType } from "zod";

const SCHEMA = {
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  SECRETS_ENCRYPTION_KEY: z.string().length(64),
  OFFICIAL_RUNNER_SECRET: z.string().length(64),
  SENTRY_DSN: z.url().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  VITEST: z.enum(["true", "false"]).optional(),
  VM0_DEBUG: z.string().optional(),
} as const;

const baseEnv = createEnv<undefined, typeof SCHEMA>({
  server: SCHEMA,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

type EnvShape = typeof baseEnv;
export type EnvKey = keyof EnvShape;

const overrideEnv: Partial<EnvShape> = {};

export function env<K extends EnvKey>(name: K): EnvShape[K] {
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name] as EnvShape[K];
  }
  return baseEnv[name];
}

export function mockEnv<K extends EnvKey>(name: K, value: EnvShape[K]): void {
  const schema = SCHEMA[name] as ZodType;
  overrideEnv[name] = schema.parse(value) as EnvShape[K];
}

export function clearMockedEnv(): void {
  for (const key of Object.keys(overrideEnv)) {
    delete (overrideEnv as Record<string, unknown>)[key];
  }
}
