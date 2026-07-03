INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.silent', 120, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.audio', 180, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.silent.4k', 360, 1),
  ('video', 'fal-ai/veo3.1/fast', 'output_video_seconds.audio.4k', 420, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.silent', 240, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.audio', 480, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.silent.4k', 480, 1),
  ('video', 'fal-ai/veo3.1', 'output_video_seconds.audio.4k', 720, 1),
  ('video', 'fal-ai/kling-video/o3/standard/text-to-video', 'output_video_seconds.silent', 101, 1),
  ('video', 'fal-ai/kling-video/o3/standard/text-to-video', 'output_video_seconds.audio', 135, 1),
  ('video', 'fal-ai/kling-video/v3/4k/text-to-video', 'output_video_seconds.silent.4k', 504, 1),
  ('video', 'fal-ai/kling-video/v3/4k/text-to-video', 'output_video_seconds.audio.4k', 504, 1),
  ('video', 'bytedance/seedance-2.0/text-to-video', 'output_video_tokens', 1680, 100000),
  ('video', 'bytedance/seedance-2.0/fast/text-to-video', 'output_video_tokens', 1344, 100000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
