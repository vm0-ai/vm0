import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "../index";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for @vm0/db integration tests");
}

const pool = new Pool({ connectionString: databaseUrl });

export const db = drizzle(pool, { schema });

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function capturePgError(
  promise: Promise<unknown>,
): Promise<{ code?: string }> {
  return promise.then(
    () => {
      return {};
    },
    (err: unknown) => {
      const cause = (err as { cause?: { code?: string } }).cause;
      return { code: cause?.code };
    },
  );
}

afterAll(async () => {
  await pool.end();
});
