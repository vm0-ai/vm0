-- Derive Kimi K3 category prices from the existing Kimi K2.7 Code prices.
WITH "price_multipliers" ("category", "numerator", "denominator") AS (
  VALUES
    ('tokens.cache_creation', 60, 19),
    ('tokens.cache_read', 15, 8),
    ('tokens.input', 60, 19),
    ('tokens.output', 15, 4)
)
INSERT INTO "usage_pricing" (
  "kind",
  "provider",
  "category",
  "unit_price",
  "unit_size"
)
SELECT
  "source"."kind",
  'kimi-k3',
  "source"."category",
  round(
    "source"."unit_price"::numeric
      * "multiplier"."numerator"
      / "multiplier"."denominator"
  )::bigint,
  "source"."unit_size"
FROM "usage_pricing" AS "source"
JOIN "price_multipliers" AS "multiplier"
  ON "multiplier"."category" = "source"."category"
WHERE "source"."kind" = 'model'
  AND "source"."provider" = 'kimi-k2.7-code'
ON CONFLICT ("kind", "provider", "category") DO UPDATE
SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
