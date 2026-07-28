ALTER TABLE "chat_messages" DROP COLUMN "structured_prompt_with_feedback";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "draft_structured_prompt_with_feedback";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" DROP COLUMN "draft_structured_prompt_with_feedback";