CREATE TABLE "usage_pack_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_pack_subscription_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"invitation_id" text,
	"usage_pack_usd" integer NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" varchar(30) DEFAULT 'pending_payment' NOT NULL,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_allocations_owner" CHECK (("usage_pack_allocations"."user_id" IS NOT NULL AND "usage_pack_allocations"."invitation_id" IS NULL) OR ("usage_pack_allocations"."user_id" IS NULL AND "usage_pack_allocations"."invitation_id" IS NOT NULL)),
	CONSTRAINT "chk_usage_pack_allocations_package" CHECK ("usage_pack_allocations"."usage_pack_usd" IN (20, 50, 100, 200)),
	CONSTRAINT "chk_usage_pack_allocations_status" CHECK ("usage_pack_allocations"."status" IN ('pending_payment', 'active', 'pending_invitation', 'inactive')),
	CONSTRAINT "chk_usage_pack_allocations_period" CHECK (("usage_pack_allocations"."current_period_start" IS NULL AND "usage_pack_allocations"."current_period_end" IS NULL) OR ("usage_pack_allocations"."current_period_start" IS NOT NULL AND "usage_pack_allocations"."current_period_end" IS NOT NULL AND "usage_pack_allocations"."current_period_end" > "usage_pack_allocations"."current_period_start"))
);
--> statement-breakpoint
CREATE TABLE "usage_pack_invoice_fulfillments" (
	"stripe_invoice_id" text PRIMARY KEY NOT NULL,
	"usage_pack_subscription_id" uuid NOT NULL,
	"period_start" timestamp,
	"period_end" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_invoice_fulfillments_period" CHECK ("usage_pack_invoice_fulfillments"."period_start" IS NULL OR "usage_pack_invoice_fulfillments"."period_end" > "usage_pack_invoice_fulfillments"."period_start")
);
--> statement-breakpoint
CREATE TABLE "usage_pack_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"tier" varchar(20) NOT NULL,
	"stripe_plan_price_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_subscription_id" text,
	"subscription_status" varchar(30) DEFAULT 'checkout_pending' NOT NULL,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_subscriptions_tier" CHECK ("usage_pack_subscriptions"."tier" IN ('pro', 'team')),
	CONSTRAINT "chk_usage_pack_subscriptions_period" CHECK (("usage_pack_subscriptions"."current_period_start" IS NULL AND "usage_pack_subscriptions"."current_period_end" IS NULL) OR ("usage_pack_subscriptions"."current_period_start" IS NOT NULL AND "usage_pack_subscriptions"."current_period_end" IS NOT NULL AND "usage_pack_subscriptions"."current_period_end" > "usage_pack_subscriptions"."current_period_start"))
);
--> statement-breakpoint
ALTER TABLE "usage_pack_allocations" ADD CONSTRAINT "usage_pack_allocations_usage_pack_subscription_id_usage_pack_subscriptions_id_fk" FOREIGN KEY ("usage_pack_subscription_id") REFERENCES "public"."usage_pack_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_pack_invoice_fulfillments" ADD CONSTRAINT "usage_pack_invoice_fulfillments_usage_pack_subscription_id_usage_pack_subscriptions_id_fk" FOREIGN KEY ("usage_pack_subscription_id") REFERENCES "public"."usage_pack_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_allocations_current_user" ON "usage_pack_allocations" USING btree ("usage_pack_subscription_id","user_id") WHERE "usage_pack_allocations"."user_id" IS NOT NULL AND "usage_pack_allocations"."status" <> 'inactive';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_allocations_current_invitation" ON "usage_pack_allocations" USING btree ("usage_pack_subscription_id","invitation_id") WHERE "usage_pack_allocations"."invitation_id" IS NOT NULL AND "usage_pack_allocations"."status" <> 'inactive';--> statement-breakpoint
CREATE INDEX "idx_usage_pack_allocations_subscription_status" ON "usage_pack_allocations" USING btree ("usage_pack_subscription_id","status");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_allocations_org_user" ON "usage_pack_allocations" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_allocations_org_invitation" ON "usage_pack_allocations" USING btree ("org_id","invitation_id");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_invoice_fulfillments_subscription" ON "usage_pack_invoice_fulfillments" USING btree ("usage_pack_subscription_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscriptions_checkout_session" ON "usage_pack_subscriptions" USING btree ("stripe_checkout_session_id") WHERE "usage_pack_subscriptions"."stripe_checkout_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscriptions_stripe_subscription" ON "usage_pack_subscriptions" USING btree ("stripe_subscription_id") WHERE "usage_pack_subscriptions"."stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_subscriptions_org" ON "usage_pack_subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_subscriptions_reconcile" ON "usage_pack_subscriptions" USING btree ("subscription_status","current_period_end");