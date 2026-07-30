-- Perform only catalog changes while holding ACCESS EXCLUSIVE, and fail fast
-- rather than waiting behind live traffic.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

ALTER TABLE "chat_threads"
  DROP CONSTRAINT "chat_threads_draft_user_message_check",
  DROP COLUMN "draft_content";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts"
  DROP CONSTRAINT "zero_agent_drafts_draft_user_message_check",
  DROP COLUMN "draft_content";--> statement-breakpoint
ALTER TABLE "chat_threads" RENAME CONSTRAINT "chat_threads_draft_user_message_check_0746" TO "chat_threads_draft_user_message_check";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" RENAME CONSTRAINT "zero_agent_drafts_draft_user_message_check_0746" TO "zero_agent_drafts_draft_user_message_check";
