-- JoggAI Professional API pricing: $399 / 800 credits. Talking-avatar
-- generation consumes one JoggAI credit per started two minutes of output.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('video', 'joggai-talking-avatar', 'output_video_joggai_credits', 499, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
