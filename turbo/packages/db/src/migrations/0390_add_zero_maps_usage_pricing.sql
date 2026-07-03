-- Google Maps base-tier USD CPM converted to credits at $0.001/credit with 20% markup.
-- $5 CPM -> 6 credits, $10 CPM -> 12 credits, $17 CPM -> 21 credits, $32 CPM -> 39 credits.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('maps', 'google-maps', 'geocoding', 6, 1),
  ('maps', 'google-maps', 'routes.directions', 6, 1),
  ('maps', 'google-maps', 'routes.directions.advanced', 12, 1),
  ('maps', 'google-maps', 'places.text_search.pro', 39, 1),
  ('maps', 'google-maps', 'places.details.essentials', 6, 1),
  ('maps', 'google-maps', 'places.details.pro', 21, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
