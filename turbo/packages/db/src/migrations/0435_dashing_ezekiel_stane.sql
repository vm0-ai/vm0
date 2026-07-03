ALTER TABLE "org_metadata" ADD COLUMN "pending_subscription_schedule_id" text;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "pending_subscription_target_tier" text;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "pending_subscription_change_at" timestamp;
