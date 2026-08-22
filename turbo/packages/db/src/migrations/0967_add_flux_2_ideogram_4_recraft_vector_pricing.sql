-- FLUX.2 Pro, Ideogram 4, and Recraft V4.1 Vector list prices with a 20%
-- markup. Unit prices use 1 USD = 1000 credits.
-- fal prices retrieved 2026-08-22:
--   https://fal.ai/models/fal-ai/flux-2-pro
--     $0.03 for the first processed MP, $0.015 for each additional MP
--   https://fal.ai/models/ideogram/v4
--     $0.0075/$0.015/$0.025 per output MP for Turbo/Balanced/Quality
--   https://fal.ai/models/fal-ai/recraft/v4.1/text-to-vector
--     $0.08 per SVG image
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('image', 'fal-ai/flux-2-pro', 'processed_megapixel.first', 36, 1),
  ('image', 'fal-ai/flux-2-pro', 'processed_megapixel.additional', 18, 1),
  ('image', 'ideogram/v4', 'output_megapixel.turbo', 9, 1),
  ('image', 'ideogram/v4', 'output_megapixel.balanced', 18, 1),
  ('image', 'ideogram/v4', 'output_megapixel.quality', 30, 1),
  ('image', 'fal-ai/recraft/v4.1/text-to-vector', 'output_image', 96, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
