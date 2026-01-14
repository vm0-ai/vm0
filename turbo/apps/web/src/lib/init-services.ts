import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeonServerless } from "drizzle-orm/neon-serverless";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { Services } from "../types/global";
import { initMetrics } from "./metrics";

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: PgPool | undefined;
let _neonPool: NeonPool | undefined;
let _db:
  | NodePgDatabase<typeof schema>
  | NeonDatabase<typeof schema>
  | undefined;
let _services: Services | undefined;
let _metricsInitialized = false;

/**
 * Initialize global services
 * Call this at the entry point of serverless functions
 *
 * @example
 * // In API Route
 * export async function GET() {
 *   initServices();
 *   const users = await services.db.select().from(users);
 * }
 */
export function initServices(): void {
  // Already initialized
  if (_services) {
    return;
  }

  const isVercel = !!process.env.VERCEL;

  _services = {
    get env() {
      if (!_env) {
        _env = env();
      }
      return _env;
    },
    get pool() {
      if (isVercel) {
        // In Vercel serverless, use Neon WebSocket pool instead of pg pool
        throw new Error(
          "pg Pool is not available in Vercel serverless environment. " +
            "Use services.db directly with Neon WebSocket mode.",
        );
      }
      if (!_pool) {
        // Use regular pg driver for local development
        _pool = new PgPool({
          connectionString: this.env.DATABASE_URL,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        });
      }
      return _pool;
    },
    get db() {
      if (!_db) {
        if (isVercel) {
          // Use Neon WebSocket mode for Vercel serverless environment
          // This supports interactive transactions (required for storage commit)
          // See: https://neon.com/docs/serverless/serverless-driver
          if (!_neonPool) {
            _neonPool = new NeonPool({
              connectionString: this.env.DATABASE_URL,
              // Limit max connections to avoid exhausting Neon's connection pool
              // Neon preview branches have ~5 connections by default
              max: 3,
            });
          }
          _db = drizzleNeonServerless({ client: _neonPool, schema });
        } else {
          // Use regular pg driver with pool for local development
          _db = drizzleNodePg(this.pool, { schema });
        }
      }
      return _db;
    },
  };

  // Define getter on globalThis to ensure services is always available after init
  Object.defineProperty(globalThis, "services", {
    get() {
      if (!_services) {
        throw new Error("Services not initialized. Call initServices() first.");
      }
      return _services;
    },
    configurable: true,
  });

  // Initialize metrics (idempotent)
  if (!_metricsInitialized) {
    _metricsInitialized = true;
    const envVars = _services.env;
    if (!envVars.AXIOM_DATASET_SUFFIX) {
      throw new Error(
        "AXIOM_DATASET_SUFFIX is required. Set to 'dev' or 'prod'.",
      );
    }
    initMetrics({
      serviceName: "vm0-web",
      axiomToken: envVars.AXIOM_TOKEN,
      environment: envVars.AXIOM_DATASET_SUFFIX,
    });
  }
}
