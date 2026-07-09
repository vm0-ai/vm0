ALTER TABLE "org_usage_allowance_entitlements" ADD COLUMN "effective_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "org_usage_allowance_entitlements" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "org_usage_allowance_entitlements" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "org_usage_allowance_entitlements" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "org_usage_allowance_entitlements" ADD COLUMN "stripe_invoice_id" text;--> statement-breakpoint
CREATE INDEX "idx_org_usage_allowance_entitlements_stripe_subscription" ON "org_usage_allowance_entitlements" USING btree ("stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "org_usage_allowance_entitlements" ADD CONSTRAINT "chk_org_usage_allowance_entitlement_time" CHECK ("org_usage_allowance_entitlements"."expires_at" IS NULL OR "org_usage_allowance_entitlements"."expires_at" > "org_usage_allowance_entitlements"."effective_at");