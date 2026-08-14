-- vm0:non-transactional

-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop the generated name first so replay can rebuild it instead of skipping it.
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_events_created_at_id";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_chat_events_created_at_id"
ON "chat_events" USING btree ("created_at", "id");
