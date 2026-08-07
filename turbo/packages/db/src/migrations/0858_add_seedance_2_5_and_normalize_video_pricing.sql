-- Normalize every video SKU to a 20% gross margin: price = provider cost / 0.8.
-- Unit prices use 1 USD = 1000 credits.
-- BytePlus prices: https://docs.byteplus.com/en/docs/ModelArk/1544106
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('video', 'dreamina-seedance-2-5-260628', 'output_video_tokens.480p_720p.no_video', 13375, 1000000),
  ('video', 'dreamina-seedance-2-5-260628', 'output_video_tokens.480p_720p.with_video', 8000, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.480p_720p.no_video', 8750, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.480p_720p.with_video', 5375, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.1080p.no_video', 9625, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.1080p.with_video', 5875, 1000000),
  ('video', 'dreamina-seedance-2-0-fast-260128', 'output_video_tokens.480p_720p.no_video', 7000, 1000000),
  ('video', 'dreamina-seedance-2-0-fast-260128', 'output_video_tokens.480p_720p.with_video', 4125, 1000000),
  ('video', 'seedance-1-5-pro-251215', 'output_video_tokens.audio', 3000, 1000000),
  ('video', 'seedance-1-5-pro-251215', 'output_video_tokens.silent', 1500, 1000000),
  ('video', 'MiniMax-H3', 'output_video_seconds.768p', 100, 1),
  ('video', 'MiniMax-H3', 'output_video_seconds.2k', 163, 1),
  ('video', 'MiniMax-H3', 'input_video_seconds.768p', 100, 1),
  ('video', 'MiniMax-H3', 'input_video_seconds.2k', 163, 1),
  ('video', 'MiniMax-H3', 'input_image.additional', 50, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.audio', 188, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.silent', 125, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.audio.4k', 438, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.silent.4k', 375, 1),
  ('video', 'fal-ai/kling-video/v3/4k/text-to-video', 'output_video_seconds.audio.4k', 525, 1),
  ('video', 'fal-ai/kling-video/v3/4k/text-to-video', 'output_video_seconds.silent.4k', 525, 1),
  ('video', 'joggai-talking-avatar', 'output_video_joggai_credits', 623, 1),
  ('video', 'bytedance/seedance-2.0/text-to-video', 'output_video_tokens', 1750, 100000),
  ('video', 'bytedance/seedance-2.0/fast/text-to-video', 'output_video_tokens', 1400, 100000),
  ('video', 'fal-ai/kling-video/o3/standard/text-to-video', 'output_video_seconds.audio', 141, 1),
  ('video', 'fal-ai/kling-video/o3/standard/text-to-video', 'output_video_seconds.silent', 105, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.audio', 500, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.silent', 250, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.audio.4k', 750, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.silent.4k', 500, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
