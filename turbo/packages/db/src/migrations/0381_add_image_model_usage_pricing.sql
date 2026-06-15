INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('image', 'gpt-image-1.5', 'tokens.input.text', 9600, 1000000),
  ('image', 'gpt-image-1.5', 'tokens.input.image', 9600, 1000000),
  ('image', 'gpt-image-1.5', 'tokens.output.image', 38400, 1000000),
  ('image', 'gpt-image-1', 'tokens.input.text', 6000, 1000000),
  ('image', 'gpt-image-1', 'tokens.input.image', 12000, 1000000),
  ('image', 'gpt-image-1', 'tokens.output.image', 48000, 1000000),
  ('image', 'gpt-image-1-mini', 'tokens.input.text', 1200, 1000000),
  ('image', 'gpt-image-1-mini', 'tokens.input.image', 2400, 1000000),
  ('image', 'gpt-image-1-mini', 'tokens.output.image', 12000, 1000000),
  ('image', 'fal-ai/flux-pro/v1.1', 'output_megapixel', 48, 1),
  ('image', 'fal-ai/flux-pro/v1.1-ultra', 'output_image', 72, 1),
  ('image', 'fal-ai/qwen-image', 'output_megapixel', 24, 1),
  ('image', 'fal-ai/bytedance/seedream/v4/text-to-image', 'output_image', 36, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
