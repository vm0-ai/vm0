DROP TRIGGER "sync_gmail_processed_events_automation_id" ON "gmail_processed_events";--> statement-breakpoint
DROP TRIGGER "sync_google_calendar_processed_events_automation_id" ON "google_calendar_processed_events";--> statement-breakpoint
DROP TRIGGER "sync_google_workspace_processed_events_automation_id" ON "google_workspace_processed_events";--> statement-breakpoint
DROP TRIGGER "sync_notion_workflow_pending_events_automation_id" ON "notion_workflow_pending_events";--> statement-breakpoint
DROP TRIGGER "sync_workflow_github_processed_events_automation_id" ON "zero_workflow_github_processed_events";--> statement-breakpoint
DROP TRIGGER "sync_workflow_webhook_deliveries_automation_id" ON "zero_workflow_webhook_deliveries";--> statement-breakpoint
DROP FUNCTION "sync_workflow_event_automation_id"();--> statement-breakpoint
ALTER TABLE "gmail_processed_events" DROP CONSTRAINT "gmail_processed_events_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" DROP CONSTRAINT "google_calendar_processed_events_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" DROP CONSTRAINT "google_workspace_processed_events_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" DROP CONSTRAINT "notion_workflow_pending_events_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_workflow_github_processed_events" DROP CONSTRAINT "zero_workflow_github_processed_events_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" DROP CONSTRAINT "zero_workflow_webhook_deliveries_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
DROP INDEX "idx_gmail_processed_events_event";--> statement-breakpoint
DROP INDEX "idx_google_calendar_processed_events_event";--> statement-breakpoint
DROP INDEX "idx_google_workspace_processed_events_cloudevent";--> statement-breakpoint
DROP INDEX "idx_google_workspace_processed_events_transcript";--> statement-breakpoint
DROP INDEX "idx_notion_pending_events_trigger_page_family_active";--> statement-breakpoint
DROP INDEX "idx_zero_workflow_github_processed_delivery";--> statement-breakpoint
DROP INDEX "idx_zero_workflow_webhook_deliveries_key";--> statement-breakpoint
DROP INDEX "idx_zero_workflow_webhook_deliveries_received";--> statement-breakpoint
ALTER TABLE "gmail_processed_events" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "zero_workflow_github_processed_events" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" DROP COLUMN "trigger_id";
