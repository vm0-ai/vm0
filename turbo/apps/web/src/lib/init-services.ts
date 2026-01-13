import { Pool as PgPool } from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { join } from "path";
import { readdirSync, readFileSync } from "fs";
import { schema } from "../db/db";
import { env, type Env } from "../env";
import type { Database, Services } from "../types/global";

// Migrations directory
const MIGRATIONS_DIR = join(__dirname, "../db/migrations");

// Private variables for singleton instances
let _env: Env | undefined;
let _pool: PgPool | NeonPool | undefined;
let _pglite: PGlite | undefined;
let _db: Database | undefined;
let _services: Services | undefined;
let _pgliteReady: Promise<void> | undefined;

/**
 * Run migrations on PGlite instance
 */
async function runPgliteMigrations(client: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    await client.exec(sql);
  }
}

/**
 * Initialize global services
 * Call this at the entry point of serverless functions
 *
 * Environment selection:
 * - No DATABASE_URL: Use PGlite (in-memory for tests, file-based for dev)
 * - DATABASE_URL + VERCEL: Use Neon serverless driver
 * - DATABASE_URL only: Use pg driver
 *
 * @example
 * // In API Route
 * export async function GET() {
 *   await initServices();
 *   const users = await services.db.select().from(users);
 * }
 */
export async function initServices(): Promise<void> {
  // Already initialized
  if (_services) {
    await _pgliteReady;
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
      const databaseUrl = this.env.DATABASE_URL;

      // PGlite mode - no pool available
      if (!databaseUrl) {
        return undefined;
      }

      if (!_pool) {
        if (isVercel) {
          // Use Neon serverless driver for Vercel
          // This driver is optimized for Neon's connection pooler and serverless environments
          // See: https://vercel.com/guides/connection-pooling-with-functions
          _pool = new NeonPool({
            connectionString: databaseUrl,
            max: 10,
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 10000,
          });
        } else {
          // Use regular pg driver for local development with DATABASE_URL
          _pool = new PgPool({
            connectionString: databaseUrl,
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
        const databaseUrl = this.env.DATABASE_URL;

        if (!databaseUrl) {
          // Use PGlite in-memory mode for local development/tests
          if (!_pglite) {
            _pglite = new PGlite();
            // Auto-run migrations for in-memory database
            _pgliteReady = runPgliteMigrations(_pglite);
          }
          // PGlite is API-compatible with NodePgDatabase at runtime
          _db = drizzlePglite({
            client: _pglite,
            schema,
          }) as unknown as Database;
        } else {
          // PostgreSQL with DATABASE_URL (Neon on Vercel, pg locally)
          _db = drizzleNodePg(this.pool!, { schema });
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

  // Eagerly initialize database connection
  // For PGlite: run migrations on in-memory database
  // For PostgreSQL: establish connection pool to catch connection errors early
  if (!process.env.DATABASE_URL) {
    void _services.db;
    await _pgliteReady;
  } else {
    void _services.db;
  }
}
