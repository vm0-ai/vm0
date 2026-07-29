UPDATE "browser_session_instances"
SET "pricing_unit_price" = 0
WHERE "settled_at" IS NULL;--> statement-breakpoint
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('browser', 'browser-use', 'provider_cost_usd_micros', 0, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
