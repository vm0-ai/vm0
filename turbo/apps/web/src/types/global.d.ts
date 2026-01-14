import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { schema } from "../db/db";
import type { Env } from "../env";

// Database type supports both local (node-postgres) and Vercel (neon-http) modes
export type Database =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

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

export {};
