-- CHECK constraint validation takes SHARE UPDATE EXCLUSIVE, which remains
-- compatible with ordinary SELECT, INSERT, and UPDATE traffic.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_draft_user_message_check_0746";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" VALIDATE CONSTRAINT "zero_agent_drafts_draft_user_message_check_0746";
