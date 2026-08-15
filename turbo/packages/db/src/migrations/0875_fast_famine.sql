CREATE TABLE "usage_pack_allocation_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_pack_subscription_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_allocation_id" uuid NOT NULL,
	"replacement_allocation_id" uuid,
	"kind" varchar(20) NOT NULL,
	"status" varchar(30) DEFAULT 'previewed' NOT NULL,
	"source_usage_pack_usd" integer NOT NULL,
	"source_stripe_price_id" text NOT NULL,
	"target_usage_pack_usd" integer,
	"target_stripe_price_id" text,
	"proration_timestamp" bigint,
	"immediate_amount_cents" integer,
	"next_recurring_amount_cents" integer,
	"currency" varchar(3),
	"effective_at" timestamp,
	"preview_expires_at" timestamp,
	"stripe_invoice_id" text,
	"stripe_schedule_id" text,
	"stripe_pending_update_expires_at" timestamp,
	"failure_reason" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_changes_kind" CHECK ("usage_pack_allocation_changes"."kind" IN ('upgrade', 'downgrade', 'removal')),
	CONSTRAINT "chk_usage_pack_changes_status" CHECK ("usage_pack_allocation_changes"."status" IN ('previewed', 'applying', 'pending_payment', 'scheduled', 'applied', 'completed', 'failed')),
	CONSTRAINT "chk_usage_pack_changes_source_package" CHECK ("usage_pack_allocation_changes"."source_usage_pack_usd" IN (20, 50, 100, 200)),
	CONSTRAINT "chk_usage_pack_changes_target_package" CHECK (("usage_pack_allocation_changes"."kind" = 'removal' AND "usage_pack_allocation_changes"."target_usage_pack_usd" IS NULL AND "usage_pack_allocation_changes"."target_stripe_price_id" IS NULL) OR ("usage_pack_allocation_changes"."kind" <> 'removal' AND "usage_pack_allocation_changes"."target_usage_pack_usd" IN (20, 50, 100, 200) AND "usage_pack_allocation_changes"."target_stripe_price_id" IS NOT NULL)),
	CONSTRAINT "chk_usage_pack_changes_amounts" CHECK (("usage_pack_allocation_changes"."immediate_amount_cents" IS NULL OR "usage_pack_allocation_changes"."immediate_amount_cents" >= 0) AND ("usage_pack_allocation_changes"."next_recurring_amount_cents" IS NULL OR "usage_pack_allocation_changes"."next_recurring_amount_cents" >= 0))
);
--> statement-breakpoint
DROP INDEX "uq_usage_pack_allocations_current_user";--> statement-breakpoint
DROP INDEX "uq_usage_pack_allocations_current_invitation";--> statement-breakpoint
ALTER TABLE "usage_pack_allocation_changes" ADD CONSTRAINT "usage_pack_allocation_changes_usage_pack_subscription_id_usage_pack_subscriptions_id_fk" FOREIGN KEY ("usage_pack_subscription_id") REFERENCES "public"."usage_pack_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_pack_allocation_changes" ADD CONSTRAINT "usage_pack_allocation_changes_source_allocation_id_usage_pack_allocations_id_fk" FOREIGN KEY ("source_allocation_id") REFERENCES "public"."usage_pack_allocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
WITH "ranked_current_users" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "org_id", "user_id"
		ORDER BY CASE "status" WHEN 'active' THEN 0 WHEN 'pending_invitation' THEN 1 ELSE 2 END, "updated_at" DESC, "id" DESC
	) AS "position"
	FROM "usage_pack_allocations"
	WHERE "user_id" IS NOT NULL AND "status" <> 'inactive'
)
UPDATE "usage_pack_allocations"
SET "status" = 'inactive', "updated_at" = now()
WHERE "id" IN (
	SELECT "id" FROM "ranked_current_users" WHERE "position" > 1
);--> statement-breakpoint
WITH "ranked_current_invitations" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "org_id", "invitation_id"
		ORDER BY CASE "status" WHEN 'pending_invitation' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, "updated_at" DESC, "id" DESC
	) AS "position"
	FROM "usage_pack_allocations"
	WHERE "invitation_id" IS NOT NULL AND "status" <> 'inactive'
)
UPDATE "usage_pack_allocations"
SET "status" = 'inactive', "updated_at" = now()
WHERE "id" IN (
	SELECT "id" FROM "ranked_current_invitations" WHERE "position" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_changes_active_org" ON "usage_pack_allocation_changes" USING btree ("org_id") WHERE "usage_pack_allocation_changes"."status" IN ('previewed', 'applying', 'pending_payment');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_changes_current_user" ON "usage_pack_allocation_changes" USING btree ("org_id","user_id") WHERE "usage_pack_allocation_changes"."status" IN ('previewed', 'applying', 'pending_payment', 'scheduled', 'applied');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_changes_stripe_invoice" ON "usage_pack_allocation_changes" USING btree ("stripe_invoice_id") WHERE "usage_pack_allocation_changes"."stripe_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_changes_subscription_status" ON "usage_pack_allocation_changes" USING btree ("usage_pack_subscription_id","status");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_changes_reconcile" ON "usage_pack_allocation_changes" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_allocations_current_user" ON "usage_pack_allocations" USING btree ("org_id","user_id") WHERE "usage_pack_allocations"."user_id" IS NOT NULL AND "usage_pack_allocations"."status" <> 'inactive';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_allocations_current_invitation" ON "usage_pack_allocations" USING btree ("org_id","invitation_id") WHERE "usage_pack_allocations"."invitation_id" IS NOT NULL AND "usage_pack_allocations"."status" <> 'inactive';
