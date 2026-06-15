ALTER TABLE "org_cache" ADD COLUMN IF NOT EXISTS "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_cache" ADD COLUMN "current_period_start" timestamp;--> statement-breakpoint
ALTER TABLE "org_cache" ADD COLUMN "current_period_end" timestamp;--> statement-breakpoint
ALTER TABLE "org_cache" ADD COLUMN "billing_cached_at" timestamp;