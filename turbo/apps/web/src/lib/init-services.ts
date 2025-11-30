import { Pool } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { Services } from "../types/global";
import ws from "ws";

// Configure Neon serverless to use ws for WebSocket connections
neonConfig.webSocketConstructor = ws;

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: Pool | NeonPool | undefined;
let _db:
  | NodePgDatabase<typeof schema>
  | NeonDatabase<typeof schema>
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
        if (isVercel) {
          // Use Neon serverless driver on Vercel for better cold start handling
          _pool = new NeonPool({
            connectionString: this.env.DATABASE_URL,
          });
        } else {
          // Use standard pg driver for local development
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
          // Use Neon serverless adapter on Vercel
          _db = drizzleNeon(this.pool as NeonPool, { schema });
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
