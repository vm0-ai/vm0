-- chat_event_search_docs is a derived projection: the search projector cron
-- rebuilds every row from chat_events. Emptying it here lets the two new
-- columns be added without a backfill or a rewrite of the existing rows, and
-- the projector replays the whole history from watermark 0. Index-path search
-- recall is degraded until that replay catches up; raise
-- CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE to shorten the window.
TRUNCATE TABLE "chat_event_search_docs", "chat_event_search_watermarks";--> statement-breakpoint
DROP INDEX "chat_event_search_docs_tsv_idx";--> statement-breakpoint
ALTER TABLE "chat_event_search_docs" ADD COLUMN "agent_compose_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_event_search_docs" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text_bigram)) STORED;--> statement-breakpoint
CREATE INDEX "chat_event_search_docs_tsv_idx" ON "chat_event_search_docs" USING gin ("tsv");