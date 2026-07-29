-- Additive rollout columns keep the pre-feedback JSONB readers safe while the
-- new API stores and serves the complete structured message document.
ALTER TABLE "chat_messages" ADD COLUMN "structured_prompt_with_feedback" jsonb;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "draft_structured_prompt_with_feedback" jsonb;--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" ADD COLUMN "draft_structured_prompt_with_feedback" jsonb;
