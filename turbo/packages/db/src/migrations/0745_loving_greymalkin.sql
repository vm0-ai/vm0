-- Validate the replacement constraints without holding ACCESS EXCLUSIVE for
-- the table scan. The final catalog-only swaps fail fast behind live traffic.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_draft_user_message_check_0745" CHECK ("chat_threads"."draft_user_message" IS NOT NULL
          OR COALESCE("chat_threads"."draft_attachments", '[]'::jsonb) = '[]'::jsonb) NOT VALID;--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" ADD CONSTRAINT "zero_agent_drafts_draft_user_message_check_0745" CHECK ("zero_agent_drafts"."draft_user_message" IS NOT NULL
          OR COALESCE("zero_agent_drafts"."draft_attachments", '[]'::jsonb) = '[]'::jsonb) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_draft_user_message_check_0745";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" VALIDATE CONSTRAINT "zero_agent_drafts_draft_user_message_check_0745";--> statement-breakpoint

ALTER TABLE "chat_threads"
  DROP CONSTRAINT "chat_threads_draft_user_message_check",
  DROP COLUMN "draft_content";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts"
  DROP CONSTRAINT "zero_agent_drafts_draft_user_message_check",
  DROP COLUMN "draft_content";--> statement-breakpoint
ALTER TABLE "chat_threads" RENAME CONSTRAINT "chat_threads_draft_user_message_check_0745" TO "chat_threads_draft_user_message_check";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" RENAME CONSTRAINT "zero_agent_drafts_draft_user_message_check_0745" TO "zero_agent_drafts_draft_user_message_check";
