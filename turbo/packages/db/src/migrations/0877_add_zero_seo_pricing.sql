-- DataForSEO reports the actual task cost in USD. Store that cost as micro-USD
-- usage and apply a 25% markup when converting it to credits.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('seo', 'dataforseo', 'provider_cost_usd_micros', 1250, 1000000)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();

-- SerpAPI Starter is $25 per 1,000 searches. One successful search therefore
-- costs 25 raw credits, or 32 credits after a 25% markup and integer rounding.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('seo', 'serpapi', 'search', 32, 1)
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();
