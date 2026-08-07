-- Normalize every active built-in video SKU to the standard 20% markup.
-- Unit prices use 1 USD = 1000 credits.
-- BytePlus prices: https://docs.byteplus.com/en/docs/ModelArk/1544106
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('video', 'dreamina-seedance-2-5-260628', 'output_video_tokens.480p_720p.no_video', 12840, 1000000),
  ('video', 'dreamina-seedance-2-5-260628', 'output_video_tokens.480p_720p.with_video', 7680, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.480p_720p.no_video', 8400, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.480p_720p.with_video', 5160, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.1080p.no_video', 9240, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.1080p.with_video', 5640, 1000000),
  ('video', 'dreamina-seedance-2-0-fast-260128', 'output_video_tokens.480p_720p.no_video', 6720, 1000000),
  ('video', 'dreamina-seedance-2-0-fast-260128', 'output_video_tokens.480p_720p.with_video', 3960, 1000000),
  ('video', 'seedance-1-5-pro-251215', 'output_video_tokens.audio', 2880, 1000000),
  ('video', 'seedance-1-5-pro-251215', 'output_video_tokens.silent', 1440, 1000000),
  ('video', 'MiniMax-H3', 'output_video_seconds.768p', 96, 1),
  ('video', 'MiniMax-H3', 'output_video_seconds.2k', 156, 1),
  ('video', 'MiniMax-H3', 'input_video_seconds.768p', 96, 1),
  ('video', 'MiniMax-H3', 'input_video_seconds.2k', 156, 1),
  ('video', 'MiniMax-H3', 'input_image.additional', 48, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.audio', 180, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.silent', 120, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.audio.4k', 420, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.silent.4k', 360, 1),
  ('video', 'fal-ai/kling-video/v3/4k/text-to-video', 'output_video_seconds.audio.4k', 504, 1),
  ('video', 'fal-ai/kling-video/v3/4k/text-to-video', 'output_video_seconds.silent.4k', 504, 1),
  ('video', 'joggai-talking-avatar', 'output_video_joggai_credits', 599, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
