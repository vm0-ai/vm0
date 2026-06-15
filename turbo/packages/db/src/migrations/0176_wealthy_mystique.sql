ALTER TABLE "org_metadata" ADD COLUMN "auto_recharge_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "auto_recharge_threshold" bigint;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "auto_recharge_amount" bigint;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "auto_recharge_pending_at" timestamp;