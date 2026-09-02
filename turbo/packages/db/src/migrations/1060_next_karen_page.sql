ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_archive_schema_version_check";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ALTER COLUMN "archive_schema_version" SET DEFAULT 8;--> statement-breakpoint
ALTER TABLE "chat_events" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_archive_schema_version_check" CHECK ("chat_event_snapshots"."archive_schema_version" IN (7, 8));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_failure_reason_check" CHECK ("chat_events"."failure_reason" IS NULL OR "chat_events"."event_type" = 'run.failed');