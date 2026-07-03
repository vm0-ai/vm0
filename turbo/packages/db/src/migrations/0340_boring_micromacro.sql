ALTER TABLE "chat_threads" ADD COLUMN "pending_message_content" text;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "pending_message_attachments" jsonb;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "pending_message_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "pending_message_updated_at" timestamp;