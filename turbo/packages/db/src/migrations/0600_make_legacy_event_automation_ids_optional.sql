-- Let the canonical automation_id be the sole application write while the
-- compatibility triggers continue backfilling trigger_id for old releases.
-- Keeping the legacy columns nullable makes this expansion safe when the
-- migration runs before the updated API is promoted.
ALTER TABLE "gmail_processed_events" ALTER COLUMN "trigger_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" ALTER COLUMN "trigger_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" ALTER COLUMN "trigger_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" ALTER COLUMN "trigger_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflow_github_processed_events" ALTER COLUMN "trigger_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" ALTER COLUMN "trigger_id" DROP NOT NULL;
