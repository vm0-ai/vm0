CREATE TABLE "org_concurrency_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_invoice_line_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"slots" integer NOT NULL,
	"starts_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_concurrency_entitlements_slots" CHECK ("org_concurrency_entitlements"."slots" > 0),
	CONSTRAINT "chk_org_concurrency_entitlements_window" CHECK ("org_concurrency_entitlements"."expires_at" > "org_concurrency_entitlements"."starts_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_concurrency_entitlements_invoice_line" ON "org_concurrency_entitlements" USING btree ("stripe_invoice_line_id");--> statement-breakpoint
CREATE INDEX "idx_org_concurrency_entitlements_org_active" ON "org_concurrency_entitlements" USING btree ("org_id","starts_at","expires_at");