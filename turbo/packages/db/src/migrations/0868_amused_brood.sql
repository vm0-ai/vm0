-- chat_event_search_docs is a derived projection: the search projector cron
-- rebuilds every row from chat_events. Emptying it first keeps the STORED
-- generated column from rewriting ~830k rows under ACCESS EXCLUSIVE inside a
-- pre-promotion migration, and it fills agent_compose_id for every row instead
-- of leaving the pre-existing rows permanently null. Index-path search recall
-- is degraded until the replay catches up; raise
-- CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE to shorten that window.
TRUNCATE TABLE "chat_event_search_docs", "chat_event_search_watermarks";--> statement-breakpoint
DROP INDEX "chat_event_search_docs_tsv_idx";--> statement-breakpoint
ALTER TABLE "chat_event_search_docs" ADD COLUMN "agent_compose_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_event_search_docs" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text_bigram)) STORED;--> statement-breakpoint
CREATE INDEX "chat_event_search_docs_tsv_idx" ON "chat_event_search_docs" USING gin ("tsv");