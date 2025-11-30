import { Pool } from "pg";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Services } from "../types/global";

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: Pool | undefined;
let _db: NodePgDatabase<typeof schema> | undefined;
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
        // Use standard pg driver with extended timeout for Neon cold starts
        // Connection pooler handles the actual pooling, so max=1 is fine for serverless
        _pool = new Pool({
          connectionString: this.env.DATABASE_URL,
          max: isVercel ? 1 : 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: isVercel ? 60000 : 10000, // 60s for Vercel cold starts
        });
      }
      return _pool;
    },
    get db() {
      if (!_db) {
        _db = drizzleNodePg(this.pool, { schema });
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
