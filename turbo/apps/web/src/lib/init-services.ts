import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import Stripe from "stripe";
import { attachDatabasePool } from "@vercel/functions";
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
let _stripe: Stripe | undefined;
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
        if (!this.env.DATABASE_URL) {
          throw new Error("DATABASE_URL is required at runtime");
        }
        if (useNeon) {
          // Opt-in WebSocket driver via @neondatabase/serverless. Kept as a
          // rollback / escape hatch (set DB_DRIVER=neon to activate) and for
          // environments without TCP support. The default path is the `pg`
          // branch below.
          _pool = new NeonPool({
            connectionString: this.env.DATABASE_URL,
            max: this.env.DB_POOL_MAX,
            idleTimeoutMillis: this.env.DB_POOL_IDLE_TIMEOUT_MS ?? 10000,
            connectionTimeoutMillis: this.env.DB_POOL_CONNECT_TIMEOUT_MS,
          });
        } else {
          // Default: node-postgres TCP pool + Vercel Fluid lifecycle.
          // `attachDatabasePool` registers a `waitUntil`-based handler that
          // closes idle connections before Fluid suspends the instance, so
          // the pool reuses connections across requests without leaking on
          // suspend.
          // Refs:
          //   https://vercel.com/guides/connection-pooling-with-functions
          //   https://neon.com/docs/guides/vercel-connection-methods
          const pgPool = new PgPool({
            connectionString: this.env.DATABASE_URL,
            max: this.env.DB_POOL_MAX,
            idleTimeoutMillis: this.env.DB_POOL_IDLE_TIMEOUT_MS ?? 5000,
            connectionTimeoutMillis: this.env.DB_POOL_CONNECT_TIMEOUT_MS,
          });
          attachDatabasePool(pgPool);
          _pool = pgPool;
        }
      }
      return _pool;
    },
    get db() {
      if (!_db) {
        if (useNeon) {
          // Drizzle adapter paired with the @neondatabase/serverless pool.
          _db = drizzleNeonServerless({
            client: this.pool as NeonPool,
            schema,
          });
        } else {
          // Default Drizzle adapter paired with node-postgres. Supports
          // interactive transactions (used by storage commit).
          _db = drizzleNodePg(this.pool as PgPool, { schema });
        }
      }
      return _db;
    },
    get stripe() {
      if (!_stripe) {
        const key = this.env.STRIPE_SECRET_KEY;
        if (!key) throw new Error("STRIPE_SECRET_KEY is required for billing");
        _stripe = new Stripe(key);
      }
      return _stripe;
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
