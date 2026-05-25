ALTER TABLE "telegram_messages" ADD COLUMN "from_display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "telegram_user_links" ADD COLUMN "telegram_display_name" varchar(255);