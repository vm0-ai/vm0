ALTER TABLE "agentphone_user_links" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "morning_brief_schedules" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_threads" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_org_installations" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams_org_installations" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_installations" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_official_user_links" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;