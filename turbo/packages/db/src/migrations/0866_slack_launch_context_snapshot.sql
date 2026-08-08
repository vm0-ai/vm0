-- Complete the Slack launch context snapshot. Both columns are additive and
-- stay null for contexts written before this release; the reader falls back to
-- the installation bot user ID and to raw Slack file blocks for those rows.
ALTER TABLE "chat_slack_context" ADD COLUMN "bot_user_id" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "message_assets" jsonb;
