ALTER TABLE "chat_feishu_context" ADD COLUMN "conversation_history" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "message_text" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "message_files" jsonb;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "chat_type" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "tenant_key" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "reply_in_thread" boolean;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "reaction_id" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "sender_open_id" text;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD COLUMN "installation_id" uuid;