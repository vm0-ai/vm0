CREATE TABLE "usage_pack_subscription_migration_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_id" uuid NOT NULL,
	"user_id" text,
	"invitation_id" text,
	"normalized_email" text,
	"role" varchar(20),
	"inviter_user_id" text,
	"usage_pack_usd" integer NOT NULL,
	"stripe_price_id" text NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"purchased_credits" bigint DEFAULT 0 NOT NULL,
	"bonus_credits" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_migration_selections_owner" CHECK (("usage_pack_subscription_migration_selections"."user_id" IS NOT NULL AND "usage_pack_subscription_migration_selections"."invitation_id" IS NULL AND "usage_pack_subscription_migration_selections"."normalized_email" IS NULL AND "usage_pack_subscription_migration_selections"."role" IS NULL AND "usage_pack_subscription_migration_selections"."inviter_user_id" IS NULL) OR ("usage_pack_subscription_migration_selections"."user_id" IS NULL AND "usage_pack_subscription_migration_selections"."invitation_id" IS NOT NULL AND "usage_pack_subscription_migration_selections"."normalized_email" IS NOT NULL AND "usage_pack_subscription_migration_selections"."role" IS NOT NULL AND "usage_pack_subscription_migration_selections"."inviter_user_id" IS NOT NULL)),
	CONSTRAINT "chk_usage_pack_migration_selections_role" CHECK ("usage_pack_subscription_migration_selections"."role" IS NULL OR "usage_pack_subscription_migration_selections"."role" IN ('admin', 'member')),
	CONSTRAINT "chk_usage_pack_migration_selections_package" CHECK ("usage_pack_subscription_migration_selections"."usage_pack_usd" IN (20, 50, 100, 200)),
	CONSTRAINT "chk_usage_pack_migration_selections_amounts" CHECK ("usage_pack_subscription_migration_selections"."unit_amount_cents" > 0 AND "usage_pack_subscription_migration_selections"."purchased_credits" > 0 AND "usage_pack_subscription_migration_selections"."bonus_credits" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_pack_subscription_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"source_tier" varchar(20) NOT NULL,
	"target_tier" varchar(20) NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"legacy_stripe_price_id" text NOT NULL,
	"legacy_stripe_item_id" text NOT NULL,
	"stripe_plan_price_id" text NOT NULL,
	"status" varchar(30) DEFAULT 'previewed' NOT NULL,
	"current_recurring_amount_cents" integer NOT NULL,
	"next_recurring_amount_cents" integer NOT NULL,
	"recurring_difference_cents" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"effective_at" timestamp NOT NULL,
	"preview_expires_at" timestamp NOT NULL,
	"stripe_schedule_id" text,
	"stripe_invoice_id" text,
	"stripe_payment_intent_id" text,
	"hosted_invoice_url" text,
	"failure_reason" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_subscription_migrations_tiers" CHECK ("usage_pack_subscription_migrations"."source_tier" IN ('pro', 'team') AND "usage_pack_subscription_migrations"."target_tier" IN ('pro', 'team')),
	CONSTRAINT "chk_usage_pack_subscription_migrations_status" CHECK ("usage_pack_subscription_migrations"."status" IN ('previewed', 'applying', 'revising', 'scheduled', 'completed', 'failed')),
	CONSTRAINT "chk_usage_pack_subscription_migrations_amounts" CHECK ("usage_pack_subscription_migrations"."current_recurring_amount_cents" >= 0 AND "usage_pack_subscription_migrations"."next_recurring_amount_cents" >= 0 AND "usage_pack_subscription_migrations"."recurring_difference_cents" = "usage_pack_subscription_migrations"."next_recurring_amount_cents" - "usage_pack_subscription_migrations"."current_recurring_amount_cents")
);
--> statement-breakpoint
ALTER TABLE "usage_pack_invitation_purchases" DROP CONSTRAINT "chk_usage_pack_invitation_purchases_amounts";--> statement-breakpoint
DROP INDEX "uq_usage_pack_invitation_purchases_payment_intent";--> statement-breakpoint
ALTER TABLE "usage_pack_subscription_migration_selections" ADD CONSTRAINT "usage_pack_subscription_migration_selections_migration_id_usage_pack_subscription_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."usage_pack_subscription_migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_migration_selections_user" ON "usage_pack_subscription_migration_selections" USING btree ("migration_id","user_id") WHERE "usage_pack_subscription_migration_selections"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_migration_selections_invitation" ON "usage_pack_subscription_migration_selections" USING btree ("migration_id","invitation_id") WHERE "usage_pack_subscription_migration_selections"."invitation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_migration_selections_migration" ON "usage_pack_subscription_migration_selections" USING btree ("migration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscription_migrations_open_org" ON "usage_pack_subscription_migrations" USING btree ("org_id") WHERE "usage_pack_subscription_migrations"."status" IN ('previewed', 'applying', 'revising', 'scheduled');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscription_migrations_open_subscription" ON "usage_pack_subscription_migrations" USING btree ("stripe_subscription_id") WHERE "usage_pack_subscription_migrations"."status" IN ('previewed', 'applying', 'revising', 'scheduled');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscription_migrations_invoice" ON "usage_pack_subscription_migrations" USING btree ("stripe_invoice_id") WHERE "usage_pack_subscription_migrations"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscription_migrations_schedule" ON "usage_pack_subscription_migrations" USING btree ("stripe_schedule_id") WHERE "usage_pack_subscription_migrations"."stripe_schedule_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_subscription_migrations_reconcile" ON "usage_pack_subscription_migrations" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_invitation_purchases_payment_intent" ON "usage_pack_invitation_purchases" USING btree ("stripe_payment_intent_id") WHERE "usage_pack_invitation_purchases"."stripe_payment_intent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_pack_invitation_purchases" ADD CONSTRAINT "chk_usage_pack_invitation_purchases_amounts" CHECK ("usage_pack_invitation_purchases"."unit_amount_cents" > 0 AND "usage_pack_invitation_purchases"."expected_amount_cents" >= 0 AND ("usage_pack_invitation_purchases"."amount_paid_cents" IS NULL OR "usage_pack_invitation_purchases"."amount_paid_cents" >= 0) AND "usage_pack_invitation_purchases"."purchased_credits" >= 0 AND "usage_pack_invitation_purchases"."bonus_credits" >= 0 AND "usage_pack_invitation_purchases"."refund_attempt" > 0);