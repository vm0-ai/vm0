-- BytePlus Seedream 5 usage is recorded as the provider's total cost in
-- micro-USD. 1,250 credits per USD applies a 25% markup to that cost.
-- Pricing: https://docs.byteplus.com/en/docs/ModelArk/1544106
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('image', 'dola-seedream-5-0-pro-260628', 'provider_cost_usd_micros', 1250, 1000000),
  ('image', 'seedream-5-0-lite-260128', 'provider_cost_usd_micros', 1250, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
