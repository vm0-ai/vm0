-- Expand phase for #21408. The compatibility view preserves the previous
-- table name while migrations run before the new API is promoted.
ALTER TABLE "workflow_user_trigger_threads" RENAME TO "workflow_user_automation_threads";--> statement-breakpoint

ALTER TABLE "workflow_user_automation_threads" RENAME CONSTRAINT "workflow_user_trigger_threads_pkey" TO "workflow_user_automation_threads_pkey";--> statement-breakpoint
ALTER TABLE "workflow_user_automation_threads" RENAME CONSTRAINT "workflow_user_trigger_threads_workflow_id_zero_workflows_id_fk" TO "workflow_user_automation_threads_workflow_id_zero_workflows_id_fk";--> statement-breakpoint
ALTER TABLE "workflow_user_automation_threads" RENAME CONSTRAINT "workflow_user_trigger_threads_chat_thread_id_chat_threads_id_fk" TO "workflow_user_automation_threads_chat_thread_id_chat_threads_id_fk";--> statement-breakpoint

ALTER INDEX "idx_workflow_user_trigger_threads_unique" RENAME TO "idx_workflow_user_automation_threads_unique";--> statement-breakpoint
ALTER INDEX "idx_workflow_user_trigger_threads_chat_thread" RENAME TO "idx_workflow_user_automation_threads_chat_thread";--> statement-breakpoint
ALTER INDEX "idx_workflow_user_trigger_threads_workflow_user" RENAME TO "idx_workflow_user_automation_threads_workflow_user";--> statement-breakpoint

CREATE VIEW "workflow_user_trigger_threads" AS
SELECT
  "id",
  "org_id",
  "user_id",
  "workflow_id",
  "chat_thread_id",
  "queue_paused_at",
  "pause_reason",
  "created_at",
  "updated_at"
FROM "workflow_user_automation_threads";
