INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('image', 'gpt-image-2', 'output_image.low.standard', 7, 1),
  ('image', 'gpt-image-2', 'output_image.low.large', 14, 1),
  ('image', 'gpt-image-2', 'output_image.medium.standard', 64, 1),
  ('image', 'gpt-image-2', 'output_image.medium.large', 121, 1),
  ('image', 'gpt-image-2', 'output_image.high.standard', 253, 1),
  ('image', 'gpt-image-2', 'output_image.high.large', 481, 1),
  ('image', 'gpt-image-1.5', 'output_image.low.standard', 11, 1),
  ('image', 'gpt-image-1.5', 'output_image.low.large', 16, 1),
  ('image', 'gpt-image-1.5', 'output_image.medium.standard', 41, 1),
  ('image', 'gpt-image-1.5', 'output_image.medium.large', 61, 1),
  ('image', 'gpt-image-1.5', 'output_image.high.standard', 160, 1),
  ('image', 'gpt-image-1.5', 'output_image.high.large', 240, 1),
  ('image', 'gpt-image-1', 'output_image.low.standard', 13, 1),
  ('image', 'gpt-image-1', 'output_image.low.large', 19, 1),
  ('image', 'gpt-image-1', 'output_image.medium.standard', 50, 1),
  ('image', 'gpt-image-1', 'output_image.medium.large', 76, 1),
  ('image', 'gpt-image-1', 'output_image.high.standard', 200, 1),
  ('image', 'gpt-image-1', 'output_image.high.large', 300, 1),
  ('image', 'gpt-image-1-mini', 'output_image.low.standard', 6, 1),
  ('image', 'gpt-image-1-mini', 'output_image.low.large', 7, 1),
  ('image', 'gpt-image-1-mini', 'output_image.medium.standard', 13, 1),
  ('image', 'gpt-image-1-mini', 'output_image.medium.large', 18, 1),
  ('image', 'gpt-image-1-mini', 'output_image.high.standard', 43, 1),
  ('image', 'gpt-image-1-mini', 'output_image.high.large', 62, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
