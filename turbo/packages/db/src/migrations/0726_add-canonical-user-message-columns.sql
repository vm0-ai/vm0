-- Migration 0726: add canonical user-message storage alongside legacy
-- compatibility columns.
ALTER TABLE "chat_events" ADD COLUMN "user_message" jsonb;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "draft_user_message" jsonb;--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" ADD COLUMN "draft_user_message" jsonb;--> statement-breakpoint
CREATE OR REPLACE VIEW "chat_messages" AS SELECT * FROM "chat_events";
