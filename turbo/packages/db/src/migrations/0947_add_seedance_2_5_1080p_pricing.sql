-- Seedance 2.5 1080p list prices with a 25% markup.
-- Unit prices use 1 USD = 1000 credits.
-- BytePlus prices: https://docs.byteplus.com/en/docs/ModelArk/1544106
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('video', 'dreamina-seedance-2-5-260628', 'output_video_tokens.1080p.no_video', 14625, 1000000),
  ('video', 'dreamina-seedance-2-5-260628', 'output_video_tokens.1080p.with_video', 8750, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
