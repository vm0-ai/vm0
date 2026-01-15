import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeonServerless } from "drizzle-orm/neon-serverless";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { Services } from "../types/global";

// Private variables for singleton instances
let _env: Env | undefined;
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
        if (isVercel) {
          // Use Neon serverless driver with drizzle for Vercel
          // This supports interactive transactions (required for storage commit)
          _db = drizzleNeonServerless({
            client: this.pool as NeonPool,
            schema,
          });
        } else {
          // Use regular pg driver with drizzle for local development
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
