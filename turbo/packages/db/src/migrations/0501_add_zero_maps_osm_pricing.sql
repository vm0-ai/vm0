-- OpenStreetMap Overpass-backed downloads and deterministic PNG renders.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('maps', 'openstreetmap', 'osm.download', 1, 1),
  ('maps', 'openstreetmap', 'osm.render.png', 2, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
