import { schema } from "@vm0/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { attachDatabasePool } from "@vercel/functions";

import { env } from "./env";
import { logger } from "./log";
import { singleton } from "./singleton";

const log = logger("api:db");

// `pg` is kept external from the bundle (vite.config.ts) so
// `@opentelemetry/instrumentation-pg`, enabled via the ESM loader hook in
// `instrument.ts`, patches it on import. That instrumentation owns the CLIENT
// spans and binds each one to the originating request's context, so there is
// no hand-rolled span wrapper here.
const pool = singleton((): Pool => {
  const pgPool = new Pool({
    allowExitOnIdle: true,
    connectionString: env("DATABASE_URL"),
    min: 1,
    max: env("DB_POOL_MAX"),
    idleTimeoutMillis: env("DB_POOL_IDLE_TIMEOUT_MS"),
    connectionTimeoutMillis: env("DB_POOL_CONNECT_TIMEOUT_MS"),
  });
  pgPool.on("error", (error: Error) => {
    log.warn("idle database client error", { error: error.message });
  });

  attachDatabasePool(pgPool);

  return pgPool;
});

export const db = singleton((): NodePgDatabase<typeof schema> => {
  return drizzle(pool(), { schema });
});

export async function closeDbPool(): Promise<void> {
  const current = pool.peek();
  if (current) {
    await current.end();
    pool.reset();
    db.reset();
  }
}
