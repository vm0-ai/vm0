import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/db";
import type { Env } from "../env";

export type Database =
  | NodePgDatabase<typeof schema>
  | PostgresJsDatabase<typeof schema>;

export type Services = {
  env: Env;
  db: Database;
  pool: Pool | undefined; // undefined on Vercel (uses postgres.js)
};

declare global {
  // getter ensures it's always defined after initServices()
  var services: Services;
}

export {};
