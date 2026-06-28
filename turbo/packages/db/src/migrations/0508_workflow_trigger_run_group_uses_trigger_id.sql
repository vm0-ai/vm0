-- Workflow triggers no longer carry a dedicated `run_group_id` column; the
-- trigger's own `id` is the run group id going forward. Before dropping the
-- column, repoint existing grouped rows so chat folding stays continuous:
-- every run / message spawned by a workflow trigger takes its group id from
-- `zero_runs.workflow_trigger_id` (== the trigger id).
UPDATE "zero_runs"
SET "run_group_id" = "zero_runs"."workflow_trigger_id"
WHERE "zero_runs"."workflow_trigger_id" IS NOT NULL;--> statement-breakpoint
UPDATE "chat_messages"
SET "run_group_id" = "zero_runs"."workflow_trigger_id"
FROM "zero_runs"
WHERE "chat_messages"."run_id" = "zero_runs"."id"
  AND "zero_runs"."workflow_trigger_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX "idx_zero_workflow_triggers_run_group";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "run_group_id";
