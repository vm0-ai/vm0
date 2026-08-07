import { sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";

export async function stripeWorkflowEventSchemaAvailable(
  db: Pick<Db | ReadonlyDb, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available: sql`
        to_regclass('public.stripe_workflow_automation_health') IS NOT NULL
        AND to_regclass('public.stripe_workflow_deliveries') IS NOT NULL
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}
