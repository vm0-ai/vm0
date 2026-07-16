-- Expand phase for #21408. The compatibility view keeps the previous API
-- release working while migrations run before the new release is promoted.
ALTER TABLE "zero_workflow_triggers" RENAME TO "zero_workflow_automations";--> statement-breakpoint

ALTER TABLE "zero_workflow_automations" RENAME CONSTRAINT "zero_workflow_triggers_pkey" TO "zero_workflow_automations_pkey";--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" RENAME CONSTRAINT "zero_workflow_triggers_workflow_id_zero_workflows_id_fk" TO "zero_workflow_automations_workflow_id_zero_workflows_id_fk";--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" RENAME CONSTRAINT "zero_workflow_triggers_schedule_config_check" TO "zero_workflow_automations_schedule_config_check";--> statement-breakpoint

ALTER INDEX "idx_zero_workflow_triggers_workflow" RENAME TO "idx_zero_workflow_automations_workflow";--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_triggers_org" RENAME TO "idx_zero_workflow_automations_org";--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_triggers_next_run" RENAME TO "idx_zero_workflow_automations_next_run";--> statement-breakpoint

ALTER TABLE "chat_message_queue" RENAME CONSTRAINT "chat_message_queue_trigger_id_zero_workflow_triggers_id_fk" TO "chat_message_queue_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "gmail_processed_events" RENAME CONSTRAINT "gmail_processed_events_trigger_id_zero_workflow_triggers_id_fk" TO "gmail_processed_events_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" RENAME CONSTRAINT "google_calendar_processed_events_trigger_id_zero_workflow_triggers_id_fk" TO "google_calendar_processed_events_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" RENAME CONSTRAINT "google_workspace_processed_events_trigger_id_zero_workflow_triggers_id_fk" TO "google_workspace_processed_events_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" RENAME CONSTRAINT "notion_workflow_pending_events_trigger_id_zero_workflow_triggers_id_fk" TO "notion_workflow_pending_events_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "zero_runs" RENAME CONSTRAINT "zero_runs_workflow_trigger_id_zero_workflow_triggers_id_fk" TO "zero_runs_workflow_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
-- #21267 still owns this legacy table's lifecycle; only its FK metadata follows
-- the target table rename so generated-schema consistency remains exact.
ALTER TABLE "zero_workflow_queue_events" RENAME CONSTRAINT "zero_workflow_queue_events_trigger_id_zero_workflow_triggers_id_fk" TO "zero_workflow_queue_events_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
-- The GitHub processed-event and memory-embedding FK identifiers are already
-- truncated before the referenced-table suffix by PostgreSQL's 63-byte limit,
-- so their physical names do not change when the target table is renamed.
ALTER TABLE "zero_workflow_webhook_deliveries" RENAME CONSTRAINT "zero_workflow_webhook_deliveries_trigger_id_zero_workflow_triggers_id_fk" TO "zero_workflow_webhook_deliveries_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_triggers" RENAME CONSTRAINT "zero_workflow_webhook_triggers_trigger_id_zero_workflow_triggers_id_fk" TO "zero_workflow_webhook_triggers_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint

CREATE VIEW "zero_workflow_triggers" AS
SELECT * FROM "zero_workflow_automations";
