import { trace } from "@opentelemetry/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import {
  createInstrumentedPgStream,
  instrumentPgClient,
  instrumentPgPool,
} from "./db-instrumentation";
import type { ApiDb } from "./db-types";
import { env } from "./env";
import { invocationResource } from "./invocation-context";
import { logger } from "./log";
import { singleton, testOverride } from "./singleton";
import { now } from "./time";

const log = logger("api:db");
const WORKER_DATABASE_RESOURCE = Symbol("worker-database");

type DatabasePoolAttachment = (pool: Pool) => void;

const { get: getPoolAttachment, set: setPoolAttachment } =
  testOverride<DatabasePoolAttachment>(() => {
    return () => {};
  });

export function configureDatabasePoolAttachment(
  attachment: DatabasePoolAttachment,
): void {
  setPoolAttachment(attachment);
}

interface SingletonValue<T> {
  (): T;
  readonly peek: () => T | undefined;
  readonly reset: () => void;
}

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

  getPoolAttachment()(pgPool);

  return pgPool;
});

const pooledDb: SingletonValue<ApiDb> = singleton((): ApiDb => {
  return drizzle(pool());
});

async function observeWorkerConnection(
  connection: Promise<unknown>,
  createdAt: number,
): Promise<boolean> {
  const [result] = await Promise.allSettled([connection]);
  if (result?.status === "fulfilled") {
    log.debug("worker database connected", {
      durationMs: Math.max(0, now() - createdAt),
    });
    return true;
  }
  log.error("worker database connection failed", {
    durationMs: Math.max(0, now() - createdAt),
    error: result?.reason,
  });
  return false;
}

function createWorkerDatabase() {
  const createdAt = now();
  let queryCount = 0;
  let queryFailureCount = 0;
  let totalQueryTimeMs = 0;
  const client = instrumentPgClient(
    new Client({
      connectionString: env("DATABASE_URL"),
      connectionTimeoutMillis: env("DB_POOL_CONNECT_TIMEOUT_MS"),
    }),
    trace.getTracer("vm0-api/pg"),
    ({ durationMs, error }) => {
      queryCount += 1;
      totalQueryTimeMs += durationMs;
      if (error !== undefined) {
        queryFailureCount += 1;
      }
      if (queryCount === 1) {
        log.debug("worker database first query settled", {
          durationMs,
          invocationToFirstQueryMs: Math.max(0, now() - createdAt),
          outcome: error === undefined ? "fulfilled" : "rejected",
        });
      }
    },
  );
  const connected = observeWorkerConnection(client.connect(), createdAt);
  return {
    value: drizzle(client),
    async dispose(): Promise<void> {
      const didConnect = await connected;
      if (didConnect) {
        await client.end();
      }
      log.debug("worker database client disposed", {
        clientLifetimeMs: Math.max(0, now() - createdAt),
        connected: didConnect,
        queryCount,
        queryFailureCount,
        totalQueryTimeMs,
      });
    },
  };
}

export const db: SingletonValue<ApiDb> = Object.assign(
  (): ApiDb => {
    const workerDatabase = invocationResource(
      WORKER_DATABASE_RESOURCE,
      createWorkerDatabase,
    );
    return workerDatabase?.value ?? pooledDb();
  },
  {
    peek: pooledDb.peek,
    reset: pooledDb.reset,
  },
);

export async function closeDbPool(): Promise<void> {
  const current = pool.peek();
  if (current) {
    await current.end();
    pool.reset();
    pooledDb.reset();
  }
}
