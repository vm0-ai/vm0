UPDATE "browser_session_instances"
SET "pricing_unit_price" = 0
WHERE "settled_at" IS NULL;--> statement-breakpoint
DELETE FROM "usage_pricing"
WHERE "kind" = 'browser'
  AND "provider" = 'browser-use'
  AND "category" = 'provider_cost_usd_micros';
