import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { schema } from "../db/db";
import type { Env } from "../env";

// Use NodePgDatabase as the base type - PGlite is API-compatible
export type Database = NodePgDatabase<typeof schema>;

export type Services = {
  env: Env;
  db: Database;
  pool?: Pool; // Optional - PGlite has no pool
};

declare global {
  // getter ensures it's always defined after initServices()
  var services: Services;
}

export {};
