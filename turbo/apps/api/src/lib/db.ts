import { schema } from "@vm0/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "./env";
import { lazySingleton } from "./lazy-singleton";

const pool = lazySingleton((): Pool => {
  return new Pool({
    allowExitOnIdle: true,
    connectionString: env("DATABASE_URL"),
    max: 5,
  });
});

export const db = lazySingleton((): NodePgDatabase<typeof schema> => {
  return drizzle(pool(), { schema });
});

export async function closeDbPool(): Promise<void> {
  const current = pool.peek();
  if (current) {
    await current.end();
    pool.reset();
    db.reset();
  }
}
