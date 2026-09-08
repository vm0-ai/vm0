-- Default list pricing, not a verification of the managed account's live rate:
-- 0.0667 HeyGen credits/second * $0.50/HeyGen credit * 1000 Okou credits/USD
-- * the existing 25% managed-service markup = 41.6875 Okou credits/second.
-- https://developers.heygen.com/docs/enterprise-pricing
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('video', 'heygen-video-agent', 'output_video_seconds', 416875, 10000)
ON CONFLICT ("kind", "provider", "category") DO NOTHING;
