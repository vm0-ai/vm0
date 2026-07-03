CREATE TABLE "org_concurrency_subscriptions" (
	"stripe_subscription_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"slots" integer NOT NULL,
	"subscription_status" varchar(20),
	"current_period_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_concurrency_subscriptions_slots" CHECK ("org_concurrency_subscriptions"."slots" > 0)
);
--> statement-breakpoint
CREATE INDEX "idx_org_concurrency_subscriptions_org" ON "org_concurrency_subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_concurrency_subscriptions_status_period" ON "org_concurrency_subscriptions" USING btree ("subscription_status","current_period_end");
