DROP INDEX "chat_event_snapshots_thread_version_idx";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ALTER COLUMN "last_event_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_snapshots_thread_version_idx" ON "chat_event_snapshots" USING btree ("chat_thread_id","archive_schema_version");