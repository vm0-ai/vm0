import { createEnv } from "@t3-oss/env-nextjs";
import { config } from "dotenv";
import { z } from "zod";

function initEnv() {
  config({ path: "./.env" });

  return createEnv({
    server: {
      DATABASE_URL: z.string().min(1),
      NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
      CLERK_SECRET_KEY: z.string().min(1),
      E2B_API_KEY: z.string().min(1).optional(),
      E2B_TEMPLATE_NAME: z.string().min(1).optional(),
      VM0_API_URL: z.string().url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
      VERCEL_URL: z.string().optional(),
      MINIMAX_ANTHROPIC_BASE_URL: z.string().url().optional(),
      MINIMAX_API_KEY: z.string().min(1).optional(),
      AWS_REGION: z.string().min(1).optional(),
      AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
      AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    },
    client: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      E2B_API_KEY: process.env.E2B_API_KEY,
      E2B_TEMPLATE_NAME: process.env.E2B_TEMPLATE_NAME,
      VM0_API_URL: process.env.VM0_API_URL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
      MINIMAX_ANTHROPIC_BASE_URL: process.env.MINIMAX_ANTHROPIC_BASE_URL,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
      AWS_REGION: process.env.AWS_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
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
