-- Custom SQL migration file; preserved across migration renumbering.
-- HeyGen self-serve v3 Studio Avatar III costs $1 per minute at 720p/1080p.
-- Charge by actual output seconds with vm0's standard video 25% markup.
-- https://developers.heygen.com/docs/pricing
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('video', 'heygen-avatar-iii', 'output_video_seconds', 1250, 60)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
