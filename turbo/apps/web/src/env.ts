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
    },
    client: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
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
