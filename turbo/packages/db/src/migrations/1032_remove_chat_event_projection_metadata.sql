ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_projection_check";--> statement-breakpoint
DROP INDEX "chat_event_snapshots_thread_version_projection_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_snapshots_thread_version_unique" ON "chat_event_snapshots" USING btree ("chat_thread_id","archive_schema_version");--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP COLUMN "projection";