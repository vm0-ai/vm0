import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Services } from "../types/global";

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: PgPool | NeonPool | undefined;
let _db: NodePgDatabase<typeof schema> | undefined;
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
          _pool = new NeonPool({
            connectionString: this.env.DATABASE_URL,
            max: 1,
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
}
