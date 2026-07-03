-- Google Maps Places Enterprise USD CPM converted to credits at $0.001/credit with 20% markup.
-- Places Details Enterprise: $20 CPM -> 24 credits.
-- Places Text Search Enterprise: $35 CPM -> 42 credits.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('maps', 'google-maps', 'places.details.enterprise', 24, 1),
  ('maps', 'google-maps', 'places.text_search.enterprise', 42, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
