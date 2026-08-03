-- vm0:non-transactional
DROP TRIGGER IF EXISTS "bridge_chat_event_run_event_sequence_number_0807" ON "chat_events";--> statement-breakpoint
DROP FUNCTION IF EXISTS "bridge_chat_event_run_event_sequence_number_0807"();--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_run_seq_unique";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "active_input_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_events" ADD COLUMN IF NOT EXISTS "active_input_sequence" integer;--> statement-breakpoint
-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop the new index name first so the full migration is safe to retry.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_run_active_input_seq_unique";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_run_active_input_seq_unique" ON "chat_events" USING btree ("run_id","active_input_sequence") WHERE "chat_events"."active_input_sequence" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN IF EXISTS "sequence_number";
