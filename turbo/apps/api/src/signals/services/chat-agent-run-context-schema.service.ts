import { sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";

export async function chatAgentRunContextSchemaAvailable(
  db: Db | ReadonlyDb,
): Promise<boolean> {
  // This probe keeps the current API safe when it deploys before migration
  // 0828. Remove it after 0828 is guaranteed everywhere and rollback closes.
  const [state] = await db
    .select({
      available: sql`
        to_regclass('public.chat_agent_run_context') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_constraint AS context_constraint
          INNER JOIN pg_catalog.pg_class AS context_relation
            ON context_relation.oid = context_constraint.conrelid
          INNER JOIN pg_catalog.pg_namespace AS context_namespace
            ON context_namespace.oid = context_relation.relnamespace
          WHERE context_namespace.nspname = 'public'
            AND context_relation.relname = 'chat_events'
            AND context_constraint.conname = 'chat_events_context_type_check'
            AND pg_get_constraintdef(context_constraint.oid) LIKE '%agent_run%'
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}
