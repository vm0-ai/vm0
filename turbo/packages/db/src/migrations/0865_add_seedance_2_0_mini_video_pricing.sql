-- Seedance 2.0 Mini list prices with a 20% gross margin:
-- price = provider cost / 0.8 and 1 USD = 1000 credits.
-- BytePlus prices: https://docs.byteplus.com/en/docs/ModelArk/1544106
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('video', 'dreamina-seedance-2-0-mini-260615', 'output_video_tokens.480p_720p.no_video', 4375, 1000000),
  ('video', 'dreamina-seedance-2-0-mini-260615', 'output_video_tokens.480p_720p.with_video', 2625, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
