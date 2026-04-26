import { schema } from "@vm0/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "./env";

let _pool: Pool | undefined;
let _db: NodePgDatabase<typeof schema> | undefined;

function pool(): Pool {
  _pool ??= new Pool({
    allowExitOnIdle: true,
    connectionString: env("DATABASE_URL"),
    max: 5,
  });

  return _pool;
}

export function db(): NodePgDatabase<typeof schema> {
  _db ??= drizzle(pool(), { schema });
  return _db;
}

export async function closeDbPool(): Promise<void> {
  await _pool?.end();
  _pool = undefined;
  _db = undefined;
}
