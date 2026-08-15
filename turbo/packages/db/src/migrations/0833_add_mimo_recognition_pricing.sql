-- Recognition records the exact OpenRouter runtime model as its provider.
-- Copy its existing managed-model pricing so both uses stay on the same rates.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
SELECT
  'image-recognition',
  'xiaomi/mimo-v2.5',
  "category",
  "unit_price",
  "unit_size"
FROM "usage_pricing"
WHERE "kind" = 'model' AND "provider" = 'mimo-v2.5'
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
