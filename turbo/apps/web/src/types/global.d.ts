import type { Pool } from "pg";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { schema } from "../db/db";
import type { Env } from "../env";

// Use PgDatabase with any query result type to support both
// node-postgres (local) and neon-serverless (Vercel serverless) modes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = PgDatabase<any, typeof schema>;

export type Services = {
  env: Env;
  db: Database;
  // Pool is only available in local development, not in Vercel serverless
  pool: Pool;
};

declare global {
  // getter ensures it's always defined after initServices()
  var services: Services;
}
