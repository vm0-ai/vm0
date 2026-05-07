INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('image', 'gpt-image-2', 'tokens.input.text', 6000, 1000000),
  ('image', 'gpt-image-2', 'tokens.input.image', 9600, 1000000),
  ('image', 'gpt-image-2', 'tokens.output.image', 36000, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
