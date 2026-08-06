-- MiniMax H3 official PAYG rates with the 2x built-in markup:
-- 768P output/input video $0.16/s, 2K output/input video $0.26/s, and each
-- reference image after the first five $0.08. Reference audio is free.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('video', 'MiniMax-H3', 'output_video_seconds.768p', 160, 1),
  ('video', 'MiniMax-H3', 'output_video_seconds.2k', 260, 1),
  ('video', 'MiniMax-H3', 'input_video_seconds.768p', 160, 1),
  ('video', 'MiniMax-H3', 'input_video_seconds.2k', 260, 1),
  ('video', 'MiniMax-H3', 'input_image.additional', 80, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
