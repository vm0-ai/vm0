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
}
