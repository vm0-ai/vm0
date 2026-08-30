import {
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Permanent dedupe claims for Official Automation result emails.
 *
 * This identity deliberately has no foreign keys. Runs, Automations, and email
 * outbox rows can all be deleted while a terminal callback remains redrivable.
 */
export const officialAutomationResultEmailClaims = pgTable(
  "official_automation_result_email_claims",
  {
    runId: uuid("run_id").notNull(),
    workflowAutomationId: uuid("workflow_automation_id").notNull(),
    emailOutboxId: uuid("email_outbox_id").defaultRandom().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "official_automation_result_email_claims_pkey",
        columns: [table.runId, table.workflowAutomationId],
      }),
      uniqueIndex("official_automation_result_email_claims_outbox_unique").on(
        table.emailOutboxId,
      ),
    ];
  },
);
