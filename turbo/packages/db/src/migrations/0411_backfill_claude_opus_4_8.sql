-- Mirror the existing Claude Opus 4.7 production setup for Claude Opus 4.8.
-- This keeps the rollout aligned with the org-level model routes that already
-- exist for Opus 4.7 while leaving any pre-existing Opus 4.8 policies intact.

INSERT INTO "usage_pricing" (
  "kind",
  "provider",
  "category",
  "unit_price",
  "unit_size"
)
SELECT
  "kind",
  'claude-opus-4-8' AS "provider",
  "category",
  "unit_price",
  "unit_size"
FROM "usage_pricing"
WHERE "kind" = 'model'
  AND "provider" = 'claude-opus-4-7'
  AND "category" IN (
    'tokens.input',
    'tokens.output',
    'tokens.cache_read',
    'tokens.cache_creation'
  )
ON CONFLICT ("kind", "provider", "category")
DO UPDATE SET
  "unit_price" = EXCLUDED."unit_price",
  "unit_size" = EXCLUDED."unit_size",
  "updated_at" = now();

WITH source_key AS (
  SELECT
    "vendor",
    "api_key",
    "label"
  FROM "vm0_api_keys"
  WHERE "vendor" = 'anthropic'
    AND "model" = 'claude-opus-4-7'
  ORDER BY "updated_at" DESC
  LIMIT 1
)
INSERT INTO "vm0_api_keys" (
  "vendor",
  "model",
  "api_key",
  "label"
)
SELECT
  "vendor",
  'claude-opus-4-8' AS "model",
  "api_key",
  COALESCE(replace("label", '4.7', '4.8'), 'Claude Opus 4.8') AS "label"
FROM source_key
WHERE NOT EXISTS (
  SELECT 1
  FROM "vm0_api_keys"
  WHERE "vendor" = 'anthropic'
    AND "model" = 'claude-opus-4-8'
);

INSERT INTO "org_model_policies" (
  "org_id",
  "model",
  "is_default",
  "default_provider_type",
  "credential_scope",
  "model_provider_id",
  "created_by_user_id",
  "updated_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "org_id",
  'claude-opus-4-8' AS "model",
  false AS "is_default",
  "default_provider_type",
  "credential_scope",
  "model_provider_id",
  "created_by_user_id",
  "updated_by_user_id",
  now(),
  now()
FROM "org_model_policies"
WHERE "model" = 'claude-opus-4-7'
ON CONFLICT ("org_id", "model") DO NOTHING;
