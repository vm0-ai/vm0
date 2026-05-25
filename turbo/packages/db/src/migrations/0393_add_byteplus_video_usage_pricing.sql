-- BytePlus ModelArk video token pricing converted to credits at $0.001/credit with a 200% provider-price multiplier.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.480p_720p.no_video', 14000, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.480p_720p.with_video', 8600, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.1080p.no_video', 15400, 1000000),
  ('video', 'dreamina-seedance-2-0-260128', 'output_video_tokens.1080p.with_video', 9400, 1000000),
  ('video', 'dreamina-seedance-2-0-fast-260128', 'output_video_tokens.480p_720p.no_video', 11200, 1000000),
  ('video', 'dreamina-seedance-2-0-fast-260128', 'output_video_tokens.480p_720p.with_video', 6600, 1000000),
  ('video', 'seedance-1-5-pro-251215', 'output_video_tokens.audio', 4800, 1000000),
  ('video', 'seedance-1-5-pro-251215', 'output_video_tokens.silent', 2400, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
