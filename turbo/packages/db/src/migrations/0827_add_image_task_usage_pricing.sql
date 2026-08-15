-- Image recognition and mark interpretation bill under task-scoped usage
-- kinds instead of kind 'model', so usage rows carry the task the model ran
-- (mirroring web-search vs people-search on one provider). Copy the current
-- per-token pricing of the backing model so the switch cannot change rates.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
SELECT 'image-recognition', "provider", "category", "unit_price", "unit_size"
FROM "usage_pricing"
WHERE "kind" = 'model' AND "provider" = 'google/gemini-3.5-flash'
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();

INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
SELECT 'image-interpret-marks', "provider", "category", "unit_price", "unit_size"
FROM "usage_pricing"
WHERE "kind" = 'model' AND "provider" = 'google/gemini-3.5-flash'
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
