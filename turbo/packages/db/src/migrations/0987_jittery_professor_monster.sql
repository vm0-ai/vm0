ALTER TABLE "chat_automation_context" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_github_context" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "app_id" varchar(255);--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "app_slug" varchar(255);--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "public_brand" text DEFAULT 'okou' NOT NULL;