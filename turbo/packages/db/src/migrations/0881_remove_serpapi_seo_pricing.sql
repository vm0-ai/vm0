-- Custom SQL migration file, put your code below! --

-- Zero SEO now uses DataForSEO exclusively.
DELETE FROM "usage_pricing"
WHERE "kind" = 'seo'
  AND "provider" = 'serpapi'
  AND "category" = 'search';
