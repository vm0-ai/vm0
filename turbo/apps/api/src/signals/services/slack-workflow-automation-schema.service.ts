import { sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";

export async function slackUserMentionedAutomationSchemaAvailable(
  db: Pick<Db | ReadonlyDb, "select">,
): Promise<boolean> {
  // Keep the API safe while it can run before migration 0831 widens the
  // automation config constraint. Remove this probe after 0831 is guaranteed
  // everywhere and the rollback window has closed.
  const [state] = await db
    .select({
      available: sql`
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = to_regclass('zero_workflow_automations')
            AND conname = 'zero_workflow_automations_schedule_config_check'
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%slack-user-mentioned%'
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

export async function slackWorkflowAutomationDeliverySchemaAvailable(
  db: Pick<Db | ReadonlyDb, "select">,
): Promise<boolean> {
  // Admission can observe API-before-migration during a rolling deploy. Probe
  // explicitly so matching Slack callbacks remain retryable instead of being
  // acknowledged and lost.
  const [state] = await db
    .select({
      available:
        sql`to_regclass('slack_workflow_automation_deliveries') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}
