-- OpenRouter Qwen2.5 7B pricing retrieved 2026-08-06 from:
-- https://openrouter.ai/qwen/qwen-2.5-7b-instruct
-- Pricing convention: 1 USD = 1000 credits.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('translation', 'qwen/qwen-2.5-7b-instruct', 'tokens.input', 100, 1000000),
  ('translation', 'qwen/qwen-2.5-7b-instruct', 'tokens.cache_read', 100, 1000000),
  ('translation', 'qwen/qwen-2.5-7b-instruct', 'tokens.output', 200, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
