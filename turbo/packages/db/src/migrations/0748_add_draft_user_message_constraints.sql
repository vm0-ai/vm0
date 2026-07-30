-- Add the replacement constraints in their own short transaction. PostgreSQL
-- retains the ACCESS EXCLUSIVE locks until commit, so validation must happen
-- in a later migration.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_draft_user_message_check_0748" CHECK ("chat_threads"."draft_user_message" IS NOT NULL
          OR COALESCE("chat_threads"."draft_attachments", '[]'::jsonb) = '[]'::jsonb) NOT VALID;--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" ADD CONSTRAINT "zero_agent_drafts_draft_user_message_check_0748" CHECK ("zero_agent_drafts"."draft_user_message" IS NOT NULL
          OR COALESCE("zero_agent_drafts"."draft_attachments", '[]'::jsonb) = '[]'::jsonb) NOT VALID;
