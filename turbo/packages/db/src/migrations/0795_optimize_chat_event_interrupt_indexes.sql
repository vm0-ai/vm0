-- vm0:non-transactional
-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop only the new index name first so this migration is safe to retry while
-- the existing full unique index continues enforcing the invariant.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_interrupts_run_id_not_null_unique";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_interrupts_run_id_not_null_unique"
ON "chat_events" USING btree ("interrupts_run_id")
WHERE "chat_events"."interrupts_run_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_interrupts_run_id_unique";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_events_run_group_id";
