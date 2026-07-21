ALTER TABLE "chat_messages" ADD COLUMN "feedback_payload" jsonb;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "draft_feedback_payload" jsonb;