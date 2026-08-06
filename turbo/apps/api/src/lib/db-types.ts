import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type ApiDb = NodePgDatabase<Record<string, never>>;
export type DbTransaction = ApiDb["transaction"];
export type Tx = Parameters<Parameters<DbTransaction>[0]>[0];
