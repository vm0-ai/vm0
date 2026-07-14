-- Expand the remaining event-source entity foreign keys before application
-- reads and writes switch to automation_id. Migration 0594 owns the shared
-- bidirectional trigger function used during the deployment/rollback window.
ALTER TABLE "gmail_processed_events" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" ADD COLUMN "automation_id" uuid;--> statement-breakpoint

UPDATE "gmail_processed_events" SET "automation_id" = "trigger_id";--> statement-breakpoint
UPDATE "google_calendar_processed_events" SET "automation_id" = "trigger_id";--> statement-breakpoint
UPDATE "google_workspace_processed_events" SET "automation_id" = "trigger_id";--> statement-breakpoint
UPDATE "notion_workflow_pending_events" SET "automation_id" = "trigger_id";--> statement-breakpoint

CREATE TRIGGER "sync_gmail_processed_events_automation_id"
BEFORE INSERT OR UPDATE ON "gmail_processed_events"
FOR EACH ROW EXECUTE FUNCTION "sync_workflow_event_automation_id"();--> statement-breakpoint
CREATE TRIGGER "sync_google_calendar_processed_events_automation_id"
BEFORE INSERT OR UPDATE ON "google_calendar_processed_events"
FOR EACH ROW EXECUTE FUNCTION "sync_workflow_event_automation_id"();--> statement-breakpoint
CREATE TRIGGER "sync_google_workspace_processed_events_automation_id"
BEFORE INSERT OR UPDATE ON "google_workspace_processed_events"
FOR EACH ROW EXECUTE FUNCTION "sync_workflow_event_automation_id"();--> statement-breakpoint
CREATE TRIGGER "sync_notion_workflow_pending_events_automation_id"
BEFORE INSERT OR UPDATE ON "notion_workflow_pending_events"
FOR EACH ROW EXECUTE FUNCTION "sync_workflow_event_automation_id"();--> statement-breakpoint

ALTER TABLE "gmail_processed_events" ALTER COLUMN "automation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" ALTER COLUMN "automation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" ALTER COLUMN "automation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" ALTER COLUMN "automation_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "gmail_processed_events" ADD CONSTRAINT "gmail_processed_events_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" ADD CONSTRAINT "google_calendar_processed_events_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" ADD CONSTRAINT "google_workspace_processed_events_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" ADD CONSTRAINT "notion_workflow_pending_events_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "gmail_processed_events" VALIDATE CONSTRAINT "gmail_processed_events_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" VALIDATE CONSTRAINT "google_calendar_processed_events_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" VALIDATE CONSTRAINT "google_workspace_processed_events_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" VALIDATE CONSTRAINT "notion_workflow_pending_events_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint

CREATE UNIQUE INDEX "idx_gmail_processed_events_automation_event" ON "gmail_processed_events" USING btree ("watch_state_id","automation_id","history_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_calendar_processed_events_automation_event" ON "google_calendar_processed_events" USING btree ("watch_state_id","automation_id","calendar_event_id","event_change_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_workspace_processed_events_automation_cloudevent" ON "google_workspace_processed_events" USING btree ("subscription_state_id","automation_id","cloud_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_workspace_processed_events_automation_transcript" ON "google_workspace_processed_events" USING btree ("subscription_state_id","automation_id","transcript_name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notion_pending_events_automation_page_family_active" ON "notion_workflow_pending_events" USING btree ("automation_id","page_id","event_family") WHERE status IN ('pending', 'running');
