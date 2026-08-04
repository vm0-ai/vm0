-- vm0:non-transactional
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_run_lifecycle_unique";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_events_thread_run_finish_created";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN IF EXISTS "run_lifecycle_event";
