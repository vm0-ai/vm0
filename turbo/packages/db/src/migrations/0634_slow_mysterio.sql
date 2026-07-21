ALTER TABLE "chat_messages" ADD COLUMN "structured_prompt" jsonb;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "draft_structured_prompt" jsonb;