CREATE TABLE "usage_pack_subscription_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_pack_subscription_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"source_tier" varchar(20) NOT NULL,
	"target_tier" varchar(20) NOT NULL,
	"status" varchar(30) DEFAULT 'previewed' NOT NULL,
	"proration_timestamp" bigint NOT NULL,
	"immediate_amount_cents" integer NOT NULL,
	"next_recurring_amount_cents" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"preview_expires_at" timestamp NOT NULL,
	"stripe_invoice_id" text,
	"stripe_pending_update_expires_at" timestamp,
	"effective_at" timestamp NOT NULL,
	"failure_reason" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_subscription_changes_tiers" CHECK ("usage_pack_subscription_changes"."source_tier" IN ('pro', 'team') AND "usage_pack_subscription_changes"."target_tier" IN ('pro', 'team')),
	CONSTRAINT "chk_usage_pack_subscription_changes_status" CHECK ("usage_pack_subscription_changes"."status" IN ('previewed', 'applying', 'pending_payment', 'completed', 'failed')),
	CONSTRAINT "chk_usage_pack_subscription_changes_amounts" CHECK ("usage_pack_subscription_changes"."immediate_amount_cents" >= 0 AND "usage_pack_subscription_changes"."next_recurring_amount_cents" >= 0)
);
--> statement-breakpoint
DROP INDEX "uq_usage_pack_changes_active_org";--> statement-breakpoint
ALTER TABLE "usage_pack_allocation_changes" ADD COLUMN "subscription_change_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_pack_subscription_changes" ADD CONSTRAINT "usage_pack_subscription_changes_usage_pack_subscription_id_usage_pack_subscriptions_id_fk" FOREIGN KEY ("usage_pack_subscription_id") REFERENCES "public"."usage_pack_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscription_changes_active_org" ON "usage_pack_subscription_changes" USING btree ("org_id") WHERE "usage_pack_subscription_changes"."status" IN ('previewed', 'applying', 'pending_payment');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscription_changes_stripe_invoice" ON "usage_pack_subscription_changes" USING btree ("stripe_invoice_id") WHERE "usage_pack_subscription_changes"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_subscription_changes_subscription_status" ON "usage_pack_subscription_changes" USING btree ("usage_pack_subscription_id","status");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_subscription_changes_reconcile" ON "usage_pack_subscription_changes" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "usage_pack_allocation_changes" ADD CONSTRAINT "usage_pack_allocation_changes_subscription_change_id_usage_pack_subscription_changes_id_fk" FOREIGN KEY ("subscription_change_id") REFERENCES "public"."usage_pack_subscription_changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_changes_subscription_change" ON "usage_pack_allocation_changes" USING btree ("subscription_change_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_changes_active_org" ON "usage_pack_allocation_changes" USING btree ("org_id") WHERE "usage_pack_allocation_changes"."subscription_change_id" IS NULL AND "usage_pack_allocation_changes"."status" IN ('previewed', 'applying', 'pending_payment');