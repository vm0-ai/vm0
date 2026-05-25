ALTER TABLE "chat_threads" ADD COLUMN "draft_content" text;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "draft_attachments" jsonb;