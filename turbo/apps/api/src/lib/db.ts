import { schema } from "@vm0/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  return databaseUrl;
}

function getPool(): Pool {
  pool ??= new Pool({
    allowExitOnIdle: true,
    connectionString: getDatabaseUrl(),
    max: 5,
  });

  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  db ??= drizzle(getPool(), { schema });
  return db;
}

export async function closeDbPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
