-- vm0:non-transactional
-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop only the new index name first so this migration is safe to retry while
-- the existing full unique index continues enforcing the invariant.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_revokes_event_id_not_null_unique";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_revokes_event_id_not_null_unique"
ON "chat_events" USING btree ("revokes_event_id")
WHERE "chat_events"."revokes_event_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_revokes_event_id_unique";
