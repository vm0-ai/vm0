import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Services } from "../types/global";
import { initMetrics } from "./metrics";

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: PgPool | NeonPool | undefined;
let _db: NodePgDatabase<typeof schema> | undefined;
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
      if (!_pool) {
        if (isVercel) {
          // Use Neon serverless driver for Vercel
          // This driver is optimized for Neon's connection pooler and serverless environments
          // See: https://vercel.com/guides/connection-pooling-with-functions
          _pool = new NeonPool({
            connectionString: this.env.DATABASE_URL,
            max: 10,
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 10000,
          });
        } else {
          // Use regular pg driver for local development
          _pool = new PgPool({
            connectionString: this.env.DATABASE_URL,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
          });
        }
      }
      return _pool;
    },
    get db() {
      if (!_db) {
        _db = drizzle(this.pool, { schema });
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
    // Use explicit AXIOM_DATASET_SUFFIX if provided, otherwise infer from environment
    const datasetSuffix =
      envVars.AXIOM_DATASET_SUFFIX ??
      (process.env.VERCEL_ENV === "production" ||
      process.env.NODE_ENV === "production"
        ? "prod"
        : "dev");
    initMetrics({
      serviceName: "vm0-web",
      axiomToken: envVars.AXIOM_TOKEN,
      environment: datasetSuffix,
    });
  }
}
