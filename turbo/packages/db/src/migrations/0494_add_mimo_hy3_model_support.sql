INSERT INTO "usage_pricing" (
    "kind",
    "provider",
    "category",
    "unit_price",
    "unit_size"
)
VALUES
    ('model', 'mimo-v2.5', 'tokens.cache_creation', 0, 1000000),
    ('model', 'mimo-v2.5', 'tokens.cache_read', 3, 1000000),
    ('model', 'mimo-v2.5', 'tokens.input', 140, 1000000),
    ('model', 'mimo-v2.5', 'tokens.output', 280, 1000000),
    ('model', 'hy3-preview', 'tokens.cache_creation', 0, 1000000),
    ('model', 'hy3-preview', 'tokens.cache_read', 21, 1000000),
    ('model', 'hy3-preview', 'tokens.input', 63, 1000000),
    ('model', 'hy3-preview', 'tokens.output', 210, 1000000)
ON CONFLICT ("kind", "provider", "category") DO UPDATE
SET
    "unit_price" = EXCLUDED."unit_price",
    "unit_size" = EXCLUDED."unit_size",
    "updated_at" = NOW();
--> statement-breakpoint
WITH source_vm0_policies AS (
  SELECT
    "org_id",
    "created_by_user_id",
    "updated_by_user_id",
    row_number() OVER (
      PARTITION BY "org_id"
      ORDER BY
        CASE WHEN "is_default" THEN 0 ELSE 1 END,
        CASE "model"
          WHEN 'claude-opus-4-8' THEN 1
          WHEN 'claude-opus-4-7' THEN 2
          WHEN 'claude-opus-4-6' THEN 3
          WHEN 'claude-sonnet-4-6' THEN 4
          WHEN 'kimi-k2.7-code' THEN 5
          WHEN 'MiniMax-M3' THEN 6
          WHEN 'glm-5.2' THEN 7
          WHEN 'glm-5.1' THEN 8
          WHEN 'deepseek-v4-pro' THEN 9
          WHEN 'gpt-5.5' THEN 10
          WHEN 'gpt-5.4' THEN 11
          WHEN 'gpt-5.4-mini' THEN 12
          ELSE 100
        END
    ) AS "route_rank"
  FROM "org_model_policies"
  WHERE "model" IN (
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'deepseek-v4-pro',
      'kimi-k2.7-code',
      'MiniMax-M3',
      'glm-5.2',
      'glm-5.1',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini'
    )
    AND "default_provider_type" = 'vm0'
    AND "credential_scope" = 'org'
    AND "model_provider_id" IS NULL
),
new_models AS (
  SELECT "model"
  FROM (
    VALUES
      ('mimo-v2.5'),
      ('hy3-preview')
  ) AS models("model")
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
    source_vm0_policies."org_id",
    new_models."model",
    false AS "is_default",
    'vm0' AS "default_provider_type",
    'org' AS "credential_scope",
    NULL AS "model_provider_id",
    source_vm0_policies."created_by_user_id",
    source_vm0_policies."updated_by_user_id",
    NOW(),
    NOW()
FROM source_vm0_policies
CROSS JOIN new_models
WHERE source_vm0_policies."route_rank" = 1
ON CONFLICT ("org_id", "model") DO NOTHING;
