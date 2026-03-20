import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type Stripe from "stripe";
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
  // Stripe client — lazy-initialized on first access, only when STRIPE_SECRET_KEY is set
  stripe: Stripe;
};

declare global {
  // getter ensures it's always defined after initServices()
  var services: Services;
  // Captured Next.js after() callbacks for test assertions (see setup.ts)
  var nextAfterCallbacks: Array<() => Promise<unknown>>;

  // Clerk custom JWT session claims (configured in Clerk Dashboard).
  // org_tier and membership_* claims have been migrated to the org and
  // org_members tables respectively. Add new claims here as needed.
  type CustomJwtSessionClaims = Record<string, unknown>;
}
