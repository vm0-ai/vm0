-- VM0 Model standard routes to GPT-5.6 Luna; premium routes to GPT-5.6 Sol.
INSERT INTO "usage_pricing" (
  "kind",
  "provider",
  "category",
  "unit_price",
  "unit_size"
)
VALUES
  ('model', 'model-standard-v1', 'tokens.input', 1000, 1000000),
  ('model', 'model-standard-v1', 'tokens.cache_read', 100, 1000000),
  ('model', 'model-standard-v1', 'tokens.cache_creation', 1250, 1000000),
  ('model', 'model-standard-v1', 'tokens.output', 6000, 1000000),
  ('model', 'model-premium-v1', 'tokens.input', 5000, 1000000),
  ('model', 'model-premium-v1', 'tokens.cache_read', 500, 1000000),
  ('model', 'model-premium-v1', 'tokens.cache_creation', 6250, 1000000),
  ('model', 'model-premium-v1', 'tokens.output', 30000, 1000000)
ON CONFLICT ("kind", "provider", "category") DO UPDATE
SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = NOW();
