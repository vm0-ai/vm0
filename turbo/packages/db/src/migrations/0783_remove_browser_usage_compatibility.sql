DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "usage_event"
    WHERE "kind" = 'browser'
      AND "status" = 'pending'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'cannot remove browser usage compatibility while pending browser usage events exist';
  END IF;
END
$$;--> statement-breakpoint
UPDATE "browser_sessions"
SET "suspension_reason" = 'reconcile'
WHERE "suspension_reason" = 'budget';--> statement-breakpoint
DELETE FROM "usage_pricing"
WHERE "kind" = 'browser'
  AND "provider" = 'browser-use'
  AND "category" = 'provider_cost_usd_micros'
  AND "unit_price" = 0
  AND "unit_size" = 1;
