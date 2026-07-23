DROP INDEX "idx_feishu_org_installations_org";--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "bot_name" varchar(255);--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "bot_avatar_url" text;--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "setup_completed_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_feishu_org_installations_org" ON "feishu_org_installations" USING btree ("org_id");