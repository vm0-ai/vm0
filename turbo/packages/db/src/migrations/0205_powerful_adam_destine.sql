CREATE TABLE "credit_expires_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"source" varchar(50) NOT NULL,
	"stripe_invoice_id" text,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_credit_expires_org_active" ON "credit_expires_record" USING btree ("org_id","expires_at") WHERE remaining > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_expires_invoice" ON "credit_expires_record" USING btree ("org_id","stripe_invoice_id");--> statement-breakpoint
INSERT INTO credit_expires_record (id, org_id, source, amount, remaining, expires_at, created_at)
SELECT
  gen_random_uuid(),
  org_id,
  'subscription_renewal',
  LEAST(credits, CASE tier WHEN 'pro' THEN 20000 WHEN 'team' THEN 120000 ELSE 0 END),
  LEAST(credits, CASE tier WHEN 'pro' THEN 20000 WHEN 'team' THEN 120000 ELSE 0 END),
  current_period_end + interval '1 month',
  now()
FROM org_metadata
WHERE tier IN ('pro', 'team')
  AND stripe_subscription_id IS NOT NULL
  AND current_period_end IS NOT NULL
  AND credits > 0;