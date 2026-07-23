-- Custom SQL migration file, put your code below! --
-- Managed Google Weather requests are free to users while remaining visible in usage events.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('weather', 'google-weather', 'current', 0, 1),
  ('weather', 'google-weather', 'forecast.hourly', 0, 1),
  ('weather', 'google-weather', 'forecast.daily', 0, 1),
  ('weather', 'google-weather', 'history.hourly', 0, 1),
  ('weather', 'google-air-quality', 'current', 0, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
