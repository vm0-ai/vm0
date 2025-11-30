import { Pool } from "pg";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { Services } from "../types/global";

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: Pool | undefined;
let _db:
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>
  | undefined;
let _services: Services | undefined;

/**
 * Initialize global services
 * Call this at the entry point of serverless functions
 *
 * Uses Neon serverless driver on Vercel for better cold start handling,
 * and standard pg driver for local development.
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
        // Pool only used for local development with node-postgres
        if (!isVercel) {
          _pool = new Pool({
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
          // Use Neon HTTP driver on Vercel for better cold start handling
          // HTTP is faster than WebSocket for serverless environments
          const sql = neon(this.env.DATABASE_URL);
          _db = drizzleNeonHttp(sql, { schema });
        } else {
          // Use node-postgres adapter for local development
          _db = drizzleNodePg(this.pool as Pool, { schema });
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
