-- Qwen Image 3 and Nano Banana 2 Lite list prices with a 20% markup.
-- Unit prices use 1 USD = 1000 credits.
-- fal prices retrieved 2026-08-21:
--   https://fal.ai/models/alibaba/qwen-image-3/text-to-image
--     $0.04 per image up to 2,250,000 output pixels, $0.075 above it
--   https://fal.ai/models/google/nano-banana-2-lite
--     token billed at $37.50 per 1M output image tokens; output is fixed at
--     1K (1024x1024 = 1120 tokens), so $0.042 per image
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('image', 'alibaba/qwen-image-3/text-to-image', 'output_image.1k', 48, 1),
  ('image', 'alibaba/qwen-image-3/text-to-image', 'output_image.2k', 90, 1),
  ('image', 'google/nano-banana-2-lite', 'output_image', 50, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
