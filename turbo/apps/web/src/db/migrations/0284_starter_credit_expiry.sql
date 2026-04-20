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
--   tier = 'free'                 — only the starter pool expires.
--   credits > 0                   — orgs at 0 balance don't get a retroactive grant.
--   NOT EXISTS (starter_grant row) — idempotent re-run guard, matches the partial
--                                    unique index above.
--   amount = LEAST(credits, 100000) — orgs with > 100k still only tag 100k as the
--                                    starter pool; the remainder stays as non-
--                                    expiring balance, the conservative reading
--                                    of "we only promise expiry on the starter grant".
INSERT INTO "credit_expires_record" (
  id, org_id, source, stripe_invoice_id, amount, remaining, expires_at, created_at
)
SELECT
  gen_random_uuid(),
  org_id,
  'starter_grant',
  NULL,
  LEAST(credits, 100000),
  LEAST(credits, 100000),
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
