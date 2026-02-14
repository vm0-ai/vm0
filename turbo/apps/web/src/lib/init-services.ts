import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeonServerless } from "drizzle-orm/neon-serverless";
import { schema } from "../db/db";
import { env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { Services } from "../types/global";

// Private variables for singleton instances
let _pool: PgPool | NeonPool | undefined;
let _db:
  | NodePgDatabase<typeof schema>
  | NeonDatabase<typeof schema>
  | undefined;
let _services: Services | undefined;

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

  const dbDriver = env().DB_DRIVER;
  const useNeon = dbDriver === "neon";

  _services = {
    get env() {
      return env();
    },
    get pool() {
      if (!_pool) {
        if (useNeon) {
          // Use Neon serverless driver (default)
          // Optimized for Neon's connection pooler and serverless environments
          // Automatically used unless DB_DRIVER=pg is explicitly set
          // See: https://vercel.com/guides/connection-pooling-with-functions
          _pool = new NeonPool({
            connectionString: this.env.DATABASE_URL,
            max: this.env.DB_POOL_MAX,
            idleTimeoutMillis: this.env.DB_POOL_IDLE_TIMEOUT_MS ?? 10000,
            connectionTimeoutMillis: this.env.DB_POOL_CONNECT_TIMEOUT_MS,
          });
        } else {
          // Use standard PostgreSQL driver
          // Set DB_DRIVER=pg for local development or self-hosted deployments
          _pool = new PgPool({
            connectionString: this.env.DATABASE_URL,
            max: this.env.DB_POOL_MAX,
            idleTimeoutMillis: this.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30000,
            connectionTimeoutMillis: this.env.DB_POOL_CONNECT_TIMEOUT_MS,
          });
        }
      }
      return _pool;
    },
    get db() {
      if (!_db) {
        if (useNeon) {
          // Use Neon serverless driver with drizzle
          // This supports interactive transactions (required for storage commit)
          _db = drizzleNeonServerless({
            client: this.pool as NeonPool,
            schema,
          });
        } else {
          // Use regular pg driver with drizzle (default)
          _db = drizzleNodePg(this.pool as PgPool, { schema });
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
}
