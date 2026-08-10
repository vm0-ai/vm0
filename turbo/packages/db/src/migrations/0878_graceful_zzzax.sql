CREATE TABLE "usage_pack_invitation_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_pack_subscription_id" uuid NOT NULL,
	"allocation_id" uuid,
	"org_id" text NOT NULL,
	"normalized_email" text NOT NULL,
	"role" varchar(20) NOT NULL,
	"inviter_user_id" text NOT NULL,
	"usage_pack_usd" integer NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" varchar(40) DEFAULT 'checkout_pending' NOT NULL,
	"current_period_start" timestamp NOT NULL,
	"current_period_end" timestamp NOT NULL,
	"proration_timestamp" bigint NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"expected_amount_cents" integer NOT NULL,
	"amount_paid_cents" integer,
	"currency" varchar(3) NOT NULL,
	"purchased_credits" bigint DEFAULT 0 NOT NULL,
	"bonus_credits" bigint DEFAULT 0 NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_checkout_expires_at" timestamp,
	"stripe_payment_intent_id" text,
	"stripe_refund_id" text,
	"refund_attempt" integer DEFAULT 1 NOT NULL,
	"clerk_invitation_id" text,
	"accepted_user_id" text,
	"failure_reason" text,
	"paid_at" timestamp,
	"accepted_at" timestamp,
	"refunded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_invitation_purchases_role" CHECK ("usage_pack_invitation_purchases"."role" IN ('admin', 'member')),
	CONSTRAINT "chk_usage_pack_invitation_purchases_package" CHECK ("usage_pack_invitation_purchases"."usage_pack_usd" IN (20, 50, 100, 200)),
	CONSTRAINT "chk_usage_pack_invitation_purchases_status" CHECK ("usage_pack_invitation_purchases"."status" IN ('checkout_pending', 'payment_succeeded', 'creating_invitation', 'invitation_pending', 'accepted_pending_activation', 'activating', 'accepted', 'refund_pending', 'refunding', 'refunded', 'failed')),
	CONSTRAINT "chk_usage_pack_invitation_purchases_period" CHECK ("usage_pack_invitation_purchases"."current_period_end" > "usage_pack_invitation_purchases"."current_period_start"),
	CONSTRAINT "chk_usage_pack_invitation_purchases_amounts" CHECK ("usage_pack_invitation_purchases"."unit_amount_cents" > 0 AND "usage_pack_invitation_purchases"."expected_amount_cents" > 0 AND ("usage_pack_invitation_purchases"."amount_paid_cents" IS NULL OR "usage_pack_invitation_purchases"."amount_paid_cents" >= 0) AND "usage_pack_invitation_purchases"."purchased_credits" >= 0 AND "usage_pack_invitation_purchases"."bonus_credits" >= 0 AND "usage_pack_invitation_purchases"."refund_attempt" > 0)
);
--> statement-breakpoint
ALTER TABLE "usage_pack_allocations" DROP CONSTRAINT "chk_usage_pack_allocations_status";--> statement-breakpoint
ALTER TABLE "usage_pack_invitation_purchases" ADD CONSTRAINT "usage_pack_invitation_purchases_usage_pack_subscription_id_usage_pack_subscriptions_id_fk" FOREIGN KEY ("usage_pack_subscription_id") REFERENCES "public"."usage_pack_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_pack_invitation_purchases" ADD CONSTRAINT "usage_pack_invitation_purchases_allocation_id_usage_pack_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."usage_pack_allocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_invitation_purchases_current_email" ON "usage_pack_invitation_purchases" USING btree ("org_id","normalized_email") WHERE "usage_pack_invitation_purchases"."status" IN ('checkout_pending', 'payment_succeeded', 'creating_invitation', 'invitation_pending', 'accepted_pending_activation', 'activating');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_invitation_purchases_allocation" ON "usage_pack_invitation_purchases" USING btree ("allocation_id") WHERE "usage_pack_invitation_purchases"."allocation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_invitation_purchases_checkout" ON "usage_pack_invitation_purchases" USING btree ("stripe_checkout_session_id") WHERE "usage_pack_invitation_purchases"."stripe_checkout_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_invitation_purchases_payment_intent" ON "usage_pack_invitation_purchases" USING btree ("stripe_payment_intent_id") WHERE "usage_pack_invitation_purchases"."stripe_payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_invitation_purchases_refund" ON "usage_pack_invitation_purchases" USING btree ("stripe_refund_id") WHERE "usage_pack_invitation_purchases"."stripe_refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_invitation_purchases_clerk_invitation" ON "usage_pack_invitation_purchases" USING btree ("clerk_invitation_id") WHERE "usage_pack_invitation_purchases"."clerk_invitation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_invitation_purchases_reconcile" ON "usage_pack_invitation_purchases" USING btree ("status","current_period_end","updated_at");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_invitation_purchases_org" ON "usage_pack_invitation_purchases" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "usage_pack_allocations" ADD CONSTRAINT "chk_usage_pack_allocations_status" CHECK ("usage_pack_allocations"."status" IN ('pending_payment', 'active', 'pending_invitation', 'paid_pending_invitation', 'inactive'));