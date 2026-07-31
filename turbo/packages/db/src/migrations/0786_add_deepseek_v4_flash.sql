-- DeepSeek API pricing retrieved 2026-07-31 from:
-- https://api-docs.deepseek.com/quick_start/pricing/
INSERT INTO "usage_pricing" (
  "kind",
  "provider",
  "category",
  "unit_price",
  "unit_size"
)
VALUES
  ('model', 'deepseek-v4-flash', 'tokens.cache_creation', 0, 1000000),
  ('model', 'deepseek-v4-flash', 'tokens.cache_read', 3, 1000000),
  ('model', 'deepseek-v4-flash', 'tokens.input', 140, 1000000),
  ('model', 'deepseek-v4-flash', 'tokens.output', 280, 1000000)
ON CONFLICT ("kind", "provider", "category") DO UPDATE
SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
--> statement-breakpoint
-- Mirror existing DeepSeek V4 Pro managed keys for DeepSeek V4 Flash.
INSERT INTO "vm0_api_keys" (
  "vendor",
  "model",
  "api_key",
  "label",
  "created_at",
  "updated_at"
)
SELECT
  "source"."vendor",
  'deepseek-v4-flash',
  "source"."api_key",
  "source"."label",
  now(),
  now()
FROM "vm0_api_keys" AS "source"
WHERE "source"."vendor" = 'deepseek'
  AND "source"."model" = 'deepseek-v4-pro'
  AND NOT EXISTS (
    SELECT 1
    FROM "vm0_api_keys" AS "target"
    WHERE "target"."vendor" = 'deepseek'
      AND "target"."model" = 'deepseek-v4-flash'
      AND "target"."api_key" = "source"."api_key"
  );
