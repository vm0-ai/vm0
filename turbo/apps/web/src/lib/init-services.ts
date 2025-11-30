import { Pool } from "pg";
import postgres from "postgres";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Services } from "../types/global";

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: Pool | undefined;
let _sql: ReturnType<typeof postgres> | undefined;
let _db:
  | NodePgDatabase<typeof schema>
  | PostgresJsDatabase<typeof schema>
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
      if (!_pool && !isVercel) {
        // Use standard pg driver for local development
        _pool = new Pool({
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
          // Use postgres.js on Vercel - better for serverless environments
          // postgres.js handles connection pooling and has faster cold starts
          if (!_sql) {
            _sql = postgres(this.env.DATABASE_URL, {
              prepare: false, // Disable prepared statements for serverless
              idle_timeout: 20, // Close idle connections quickly
              connect_timeout: 60, // 60s connection timeout for cold starts
            });
          }
          _db = drizzlePostgresJs(_sql, { schema });
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
