import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { schema } from "../db/db";
import type { Env } from "../env";

// Support both node-postgres (local) and neon-serverless (Vercel serverless) modes
export type Database =
  | NodePgDatabase<typeof schema>
  | NeonDatabase<typeof schema>;

export type Services = {
  env: Env;
  db: Database;
  // Pool is only available in local development, not in Vercel serverless
  pool: Pool;
};

declare global {
  // getter ensures it's always defined after initServices()
  var services: Services;
  // Captured Next.js after() callbacks for test assertions (see setup.ts)
  var nextAfterCallbacks: Array<() => Promise<unknown>>;

  // Clerk custom JWT session claims (configured in Clerk Dashboard)
  interface CustomJwtSessionClaims {
    org_tier?: string;
    membership_timezone?: string;
    membership_notify_email?: boolean;
    membership_notify_slack?: boolean;
  }
}
