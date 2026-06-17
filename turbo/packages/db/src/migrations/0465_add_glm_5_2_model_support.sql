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
    'glm-5.2' AS "model",
    false AS "is_default",
    "default_provider_type",
    "credential_scope",
    CASE
        WHEN "default_provider_type" = 'vm0' THEN NULL
        ELSE "model_provider_id"
    END AS "model_provider_id",
    "created_by_user_id",
    "updated_by_user_id",
    NOW(),
    NOW()
FROM "org_model_policies"
WHERE "model" = 'glm-5.1'
  AND "credential_scope" = 'org'
  AND (
    "default_provider_type" = 'vm0'
    OR (
      "default_provider_type" IN ('zai-api-key', 'openrouter-api-key')
      AND "model_provider_id" IS NOT NULL
    )
  )
ON CONFLICT ("org_id", "model") DO NOTHING;
