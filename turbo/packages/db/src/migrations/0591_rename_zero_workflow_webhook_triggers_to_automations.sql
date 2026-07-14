-- Expand phase for #21408. The compatibility view preserves the previous
-- table and column names while migrations run before the new API is promoted.
ALTER TABLE "zero_workflow_webhook_triggers" RENAME TO "zero_workflow_webhook_automations";--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_automations" RENAME COLUMN "trigger_id" TO "automation_id";--> statement-breakpoint

ALTER TABLE "zero_workflow_webhook_automations" RENAME CONSTRAINT "zero_workflow_webhook_triggers_pkey" TO "zero_workflow_webhook_automations_pkey";--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_automations" RENAME CONSTRAINT "zero_workflow_webhook_triggers_trigger_id_zero_workflow_automations_id_fk" TO "zero_workflow_webhook_automations_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint

ALTER INDEX "idx_zero_workflow_webhook_triggers_token_hash" RENAME TO "idx_zero_workflow_webhook_automations_token_hash";--> statement-breakpoint

-- This single-table projection remains automatically updatable. The explicit
-- alias is required because SELECT * would expose automation_id to old code.
CREATE VIEW "zero_workflow_webhook_triggers" AS
SELECT
  "automation_id" AS "trigger_id",
  "token_hash",
  "encrypted_token",
  "encrypted_secret",
  "secret_last_four",
  "disabled_reason",
  "last_received_at",
  "created_at",
  "updated_at"
FROM "zero_workflow_webhook_automations";
