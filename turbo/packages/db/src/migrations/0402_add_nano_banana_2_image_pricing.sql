INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('image', 'fal-ai/nano-banana-2', 'output_image', 96, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
