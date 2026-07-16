import { trace } from "@opentelemetry/api";
import { schema } from "@vm0/db";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  createInstrumentedPgStream,
  instrumentPgPool,
} from "./db-instrumentation";
import { env } from "./env";
import { logger } from "./log";
import { singleton } from "./singleton";

const log = logger("api:db");

interface SingletonValue<T> {
  (): T;
  readonly peek: () => T | undefined;
  readonly reset: () => void;
}

type ApiDb = NodePgDatabase<typeof schema>;

const pool = singleton((): Pool => {
  // The official pg instrumentation normally hooks Pool through
  // require-in-the-middle. The single-file Vercel bundle prevents that hook,
  // so instrument this lazy singleton directly. The tracer is a no-op when no
  // provider is registered, keeping local development and ordinary tests
  // lightweight.
  const pgPool = instrumentPgPool(
    new Pool({
      allowExitOnIdle: true,
      connectionString: env("DATABASE_URL"),
      min: 1,
      max: env("DB_POOL_MAX"),
      idleTimeoutMillis: env("DB_POOL_IDLE_TIMEOUT_MS"),
      connectionTimeoutMillis: env("DB_POOL_CONNECT_TIMEOUT_MS"),
      stream: () => {
        return createInstrumentedPgStream();
      },
    }),
    trace.getTracer("vm0-api/pg"),
  );
  pgPool.on("error", (error: Error) => {
    log.warn("idle database client error", { error: error.message });
  });

  attachDatabasePool(pgPool);

  return pgPool;
});

export const db: SingletonValue<ApiDb> = singleton((): ApiDb => {
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
