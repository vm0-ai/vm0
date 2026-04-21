CREATE TABLE "org_promo_redemption" (
	"org_id" text NOT NULL,
	"product_id" text NOT NULL,
	"promo_code" text NOT NULL,
	"stripe_session_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_promo_redemption" ON "org_promo_redemption" USING btree ("org_id","product_id","promo_code");