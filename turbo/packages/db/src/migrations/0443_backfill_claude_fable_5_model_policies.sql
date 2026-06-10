WITH source_policies AS (
  SELECT
    "org_id",
    "default_provider_type",
    "credential_scope",
    "model_provider_id",
    "created_by_user_id",
    "updated_by_user_id",
    row_number() OVER (
      PARTITION BY "org_id"
      ORDER BY CASE "model"
        WHEN 'claude-opus-4-8' THEN 1
        WHEN 'claude-opus-4-7' THEN 2
        WHEN 'claude-sonnet-4-6' THEN 3
      END
    ) AS "route_rank"
  FROM "org_model_policies"
  WHERE "model" IN (
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-4-6'
  )
)
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
  'claude-fable-5' AS "model",
  false AS "is_default",
  "default_provider_type",
  "credential_scope",
  "model_provider_id",
  "created_by_user_id",
  "updated_by_user_id",
  now(),
  now()
FROM source_policies
WHERE "route_rank" = 1
ON CONFLICT ("org_id", "model") DO NOTHING;
