ALTER TABLE "chat_telegram_context" ADD COLUMN "message_text" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "thread_context" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "root_message_id" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "thinking_message_id" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "user_link_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "user_link_kind" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "chat_type" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "sender_user_id" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "sender_display_name" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "sender_username" text;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD COLUMN "sender_language" text;
