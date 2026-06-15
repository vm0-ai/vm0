ALTER TABLE "org_metadata" ALTER COLUMN "credits" SET DEFAULT 2000;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "subscription_status" varchar(20);--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "current_period_end" timestamp;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "last_processed_invoice_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_stripe_customer" ON "org_metadata" USING btree ("stripe_customer_id");