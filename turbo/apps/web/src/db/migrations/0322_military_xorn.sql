ALTER TABLE "telegram_messages" ADD COLUMN "file_type" varchar(32);--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "file_mime_type" varchar(255);--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "file_size" integer;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "file_width" integer;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "file_height" integer;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "file_duration" integer;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "entities" jsonb;