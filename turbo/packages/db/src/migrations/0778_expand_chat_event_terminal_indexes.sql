-- vm0:non-transactional
-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop only the new index names first so this migration is safe to retry while
-- the existing run_lifecycle_event indexes continue enforcing the invariant.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_run_terminal_unique";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_run_terminal_unique"
ON "chat_events" USING btree ("run_id")
WHERE "chat_events"."event_type" IN (
  'run.completed',
  'run.failed',
  'run.cancelled'
);--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_events_thread_run_terminal_created";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_chat_events_thread_run_terminal_created"
ON "chat_events" USING btree ("chat_thread_id", "created_at" DESC NULLS LAST)
WHERE "chat_events"."event_type" IN (
  'run.completed',
  'run.failed',
  'run.cancelled'
);
