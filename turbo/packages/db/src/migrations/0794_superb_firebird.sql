ALTER TABLE "chat_teams_context" ADD COLUMN "thread_context" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "message_text" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "message_files" jsonb;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "tenant_name" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "team_name" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "service_url" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "teams_app_id" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "bot_name" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "sender_user_id" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "sender_display_name" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "sender_principal_name" text;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "connection_id" uuid;