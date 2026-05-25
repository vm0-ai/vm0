-- Retire the silent 100k column default. Starter credits must flow through
-- ensureStarterCreditGrant() from now on; a missed call site leaves credits = 0,
-- which is visible in the UI and debuggable rather than silent.
ALTER TABLE "org_metadata" ALTER COLUMN "credits" SET DEFAULT 0;--> statement-breakpoint

-- Partial unique index for starter-grant idempotency. Coexists with
-- uq_credit_expires_invoice (partial on stripe_invoice_id IS NOT NULL);
-- starter grants have stripe_invoice_id = NULL so they don't collide.
CREATE UNIQUE INDEX "uq_credit_expires_starter_grant" ON "credit_expires_record" USING btree ("org_id") WHERE source = 'starter_grant';--> statement-breakpoint

-- Backfill: every existing free-tier org with credits > 0 gets one starter_grant
-- expires record with a 1-month TTL anchored at migration run time.
--   tier = 'free'                 — only free-tier balances expire; Pro orgs have
--                                    their own invoice-anchored expires rows.
--   credits > 0                   — orgs at 0 balance don't get a retroactive grant.
--   NOT EXISTS (starter_grant row) — idempotent re-run guard, matches the partial
--                                    unique index above.
--   amount = credits               — for free orgs, the entire balance is treated as
--                                    the expiring starter pool. Orgs with surplus
--                                    above the starter grant (promo / support / test)
--                                    are rare and accepting the whole balance under
--                                    this TTL is the simpler policy than carving out
--                                    a non-expiring remainder.
INSERT INTO "credit_expires_record" (
  id, org_id, source, stripe_invoice_id, amount, remaining, expires_at, created_at
)
SELECT
  gen_random_uuid(),
  org_id,
  'starter_grant',
  NULL,
  credits,
  credits,
  now() + interval '1 month',
  now()
FROM "org_metadata" om
WHERE tier = 'free'
  AND credits > 0
  AND NOT EXISTS (
    SELECT 1 FROM "credit_expires_record" cer
    WHERE cer.org_id = om.org_id
      AND cer.source = 'starter_grant'
  );
