ALTER TABLE "chat_slack_context" ADD COLUMN "conversation_context" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "message_text" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "message_files" jsonb;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "mention_display_names" jsonb;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "sender_display_name" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "sender_user_id" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "channel_type" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "thread_ts" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "route_thread_ts" text;