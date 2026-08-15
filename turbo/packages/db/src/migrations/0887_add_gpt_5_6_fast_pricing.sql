-- Custom SQL migration file, put your code below! --

-- GPT 5.6 Fast is billed at 2x the configured Standard rate. Copy both base
-- and long-context pricing so the migration follows the live workspace rates
-- instead of duplicating values that can drift.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
SELECT
  "kind",
  "provider",
  "category" || '.fast',
  "unit_price" * 2,
  "unit_size"
FROM "usage_pricing"
WHERE
  "kind" = 'model'
  AND "provider" IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
  AND "category" IN (
    'tokens.input',
    'tokens.output',
    'tokens.cache_read',
    'tokens.cache_creation',
    'tokens.input.long_context',
    'tokens.output.long_context',
    'tokens.cache_read.long_context',
    'tokens.cache_creation.long_context'
  )
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
