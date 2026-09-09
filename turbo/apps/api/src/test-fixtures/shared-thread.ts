import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Infrastructure-only fault: no product API can reject the artifact insert
 * after the share insert. Business fixtures still enter through public APIs.
 * The trigger matches only the UUID-owned test org, never another test's rows.
 */
export async function rejectSharedThreadArtifactWrites(
  orgId: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const functionName = `test_share_failure_${randomUUID().replaceAll("-", "")}`;
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id = TG_NAME AND NEW.logical_key LIKE 'shared-thread:%' THEN
          RAISE EXCEPTION 'Test shared-thread artifact write failed'
            USING ERRCODE = '23514', DETAIL = NEW.entity_id::text;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(orgId)} BEFORE INSERT ON artifacts
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
    signal.throwIfAborted();
  });
  return async () => {
    await db().transaction(async (tx) => {
      await tx.execute(sql`DROP TRIGGER ${sql.identifier(orgId)} ON artifacts`);
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
}
