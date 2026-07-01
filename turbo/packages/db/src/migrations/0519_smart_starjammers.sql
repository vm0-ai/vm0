ALTER TABLE "model_providers" ADD COLUMN "subscription_reset_period" varchar(64);--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "subscription_next_reset_at" timestamp;