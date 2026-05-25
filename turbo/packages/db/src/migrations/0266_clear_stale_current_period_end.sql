-- Clear past-dated current_period_end for paying orgs.
--
-- Fixes #9777: before the prior commit, `handleInvoicePaid` persisted
-- `invoice.period_end` (the invoice's accrual-period end, which collapses
-- to the creation moment for a renewal invoice) instead of the subscription
-- line item's `period.end`. Every paying org that went through at least one
-- renewal under the buggy code carries a past-dated current_period_end.
--
-- Setting these rows to NULL lets the now-correct fallback in
-- getOrgBillingPeriod() self-heal on the next read: it calls Stripe, reads
-- subscription.items.data[0].current_period_end, and writes the real value
-- back. NULL also avoids the "currentPeriodEnd is stale" warning branch.
UPDATE org_metadata
SET current_period_end = NULL
WHERE stripe_subscription_id IS NOT NULL
  AND current_period_end IS NOT NULL
  AND current_period_end < NOW();
