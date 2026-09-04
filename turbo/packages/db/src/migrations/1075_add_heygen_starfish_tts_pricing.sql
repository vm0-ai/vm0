-- HeyGen self-serve Starfish TTS costs $0.000667 per output second,
-- approximately $0.04 per generated minute.
-- https://developers.heygen.com/docs/pricing
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('audio', 'heygen-starfish-tts', 'output_audio_seconds', 40, 60)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
