-- Backfill expiry records for credits silently granted via the
-- org_metadata.credits column DEFAULT during the 0257→0284 window.
--
-- getOrCreateStripeCustomer inserted org_metadata rows without specifying
-- credits, so the column DEFAULT applied. Between migration 0257
-- (ALTER COLUMN credits SET DEFAULT 100000) and 0284 (SET DEFAULT 0),
-- every new org that went through Stripe checkout received 100,000
-- untracked credits with no matching credit_expires_record and no expiry.
--
-- Pay-as-you-go (auto_recharge) credits are unaffected: they have their
-- own credit_expires_record entries (source='auto_recharge',
-- expires_at=2999-12-31) and are excluded from the gap by the LEFT JOIN.
-- Only credits with no matching record receive the 1-month expiry.
INSERT INTO credit_expires_record (
  id, org_id, source, stripe_invoice_id, amount, remaining, expires_at, created_at
)
SELECT
  gen_random_uuid(),
  gap.org_id,
  'column_default_grant',
  NULL,
  gap.untracked,
  gap.untracked,
  gap.created_at + INTERVAL '1 month',
  NOW()
FROM (
  SELECT
    om.org_id,
    om.credits - COALESCE(SUM(cer.remaining), 0) AS untracked,
    COALESCE(om.created_at, NOW()) AS created_at
  FROM org_metadata om
  LEFT JOIN credit_expires_record cer
    ON cer.org_id = om.org_id
    AND cer.remaining > 0
    AND cer.expires_at > NOW()
  WHERE om.stripe_customer_id IS NOT NULL
    -- Limit to orgs created during the migration-0257→0284 window.
    -- 0257 went out ≈2026-04; 0284 reverted the default ≈2026-04.
    -- Use a generous window to avoid edge cases.
    AND om.created_at >= '2026-03-01'
    AND om.created_at < '2026-06-01'
  GROUP BY om.org_id, om.credits, om.created_at
  HAVING om.credits - COALESCE(SUM(cer.remaining), 0) > 0
) gap
WHERE NOT EXISTS (
  SELECT 1 FROM credit_expires_record cer2
  WHERE cer2.org_id = gap.org_id
    AND cer2.source = 'column_default_grant'
);
