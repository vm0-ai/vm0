ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_parent_snapshot_id_chat_event_snapshots_id_fk";
--> statement-breakpoint
DROP INDEX "chat_event_snapshots_thread_head_unique";--> statement-breakpoint
DROP INDEX "chat_event_snapshots_thread_version_idx";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ALTER COLUMN "last_event_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_snapshots_thread_version_idx" ON "chat_event_snapshots" USING btree ("chat_thread_id","archive_schema_version");--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP COLUMN "parent_snapshot_id";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP COLUMN "is_head";