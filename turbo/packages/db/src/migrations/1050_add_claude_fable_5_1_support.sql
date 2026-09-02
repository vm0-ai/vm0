-- Custom SQL migration file, put your code below! --

-- Derive Fable 5.1 pricing from existing configured model rates instead of
-- duplicating values that can drift. Input, output, and cache creation match
-- Fable 5; cache read is 5/4 of the Sonnet 5 rate.
DO $$
DECLARE
  "source_price_count" integer;
BEGIN
  SELECT COUNT(*)
  INTO "source_price_count"
  FROM "usage_pricing"
  WHERE
    "kind" = 'model'
    AND (
      (
        "provider" = 'claude-fable-5'
        AND "category" IN (
          'tokens.input',
          'tokens.output',
          'tokens.cache_creation'
        )
      )
      OR (
        "provider" = 'claude-sonnet-5'
        AND "category" = 'tokens.cache_read'
      )
    );

  IF "source_price_count" NOT IN (0, 4) THEN
    RAISE EXCEPTION
      'Expected zero or four source pricing rows for Claude Fable 5.1, found %',
      "source_price_count";
  END IF;
END $$;

WITH "source_pricing" AS (
  SELECT
    "kind",
    'claude-fable-5-1' AS "provider",
    "category",
    "unit_price",
    "unit_size"
  FROM "usage_pricing"
  WHERE
    "kind" = 'model'
    AND "provider" = 'claude-fable-5'
    AND "category" IN (
      'tokens.input',
      'tokens.output',
      'tokens.cache_creation'
    )

  UNION ALL

  SELECT
    "kind",
    'claude-fable-5-1' AS "provider",
    "category",
    ROUND("unit_price"::numeric * 5 / 4)::bigint AS "unit_price",
    "unit_size"
  FROM "usage_pricing"
  WHERE
    "kind" = 'model'
    AND "provider" = 'claude-sonnet-5'
    AND "category" = 'tokens.cache_read'
)
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
SELECT
  "kind",
  "provider",
  "category",
  "unit_price",
  "unit_size"
FROM "source_pricing"
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();

DO $$
DECLARE
  "source_price_count" integer;
  "target_price_count" integer;
BEGIN
  SELECT COUNT(*)
  INTO "source_price_count"
  FROM "usage_pricing"
  WHERE
    "kind" = 'model'
    AND (
      (
        "provider" = 'claude-fable-5'
        AND "category" IN (
          'tokens.input',
          'tokens.output',
          'tokens.cache_creation'
        )
      )
      OR (
        "provider" = 'claude-sonnet-5'
        AND "category" = 'tokens.cache_read'
      )
    );

  SELECT COUNT(*)
  INTO "target_price_count"
  FROM "usage_pricing"
  WHERE
    "kind" = 'model'
    AND "provider" = 'claude-fable-5-1'
    AND "category" IN (
      'tokens.input',
      'tokens.output',
      'tokens.cache_read',
      'tokens.cache_creation'
    );

  IF "source_price_count" = 4 AND "target_price_count" <> 4 THEN
    RAISE EXCEPTION
      'Expected four Claude Fable 5.1 pricing rows, found %',
      "target_price_count";
  END IF;
END $$;

-- Preserve every existing route and default while exposing Fable 5.1 beside
-- Fable 5 for organizations that already use the Built-in route. Plan
-- entitlements continue to gate restricted organizations at admission time.
INSERT INTO "org_model_policies" (
  "org_id",
  "model",
  "is_default",
  "default_provider_type",
  "credential_scope",
  "model_provider_id",
  "model_provider_surface_id",
  "created_by_user_id",
  "updated_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "org_id",
  'claude-fable-5-1',
  false,
  'built-in',
  'org',
  NULL,
  NULL,
  "created_by_user_id",
  "updated_by_user_id",
  now(),
  now()
FROM "org_model_policies"
WHERE
  "model" = 'claude-fable-5'
  AND "default_provider_type" = 'built-in'
ON CONFLICT ("org_id", "model") DO NOTHING;
