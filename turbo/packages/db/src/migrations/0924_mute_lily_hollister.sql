-- vm0:non-transactional

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_chat_events_created_at_id"
ON "chat_events" USING btree ("created_at", "id");
