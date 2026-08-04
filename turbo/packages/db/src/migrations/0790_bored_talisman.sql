-- vm0:non-transactional
-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop only this temporary cleanup index first so the migration is safe to retry.
DROP INDEX CONCURRENTLY IF EXISTS "idx_usage_event_compacted_created_id";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_usage_event_compacted_created_id"
ON "usage_event" USING btree ("created_at", "id")
WHERE "usage_event"."status" = 'compacted';
