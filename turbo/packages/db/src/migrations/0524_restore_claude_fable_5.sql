DROP TABLE IF EXISTS pg_temp.vm0_restore_claude_fable_5_policy_sources;
--> statement-breakpoint
CREATE TEMP TABLE vm0_restore_claude_fable_5_policy_sources ON COMMIT DROP AS
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
        WHEN 'claude-opus-4-6' THEN 3
        WHEN 'claude-sonnet-5' THEN 4
        WHEN 'claude-sonnet-4-6' THEN 5
      END
    ) AS "route_rank"
FROM "org_model_policies"
WHERE "model" IN (
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6'
)
  AND "default_provider_type" IN (
    'vm0',
    'claude-code-oauth-token',
    'anthropic-api-key',
    'openrouter-api-key',
    'vercel-ai-gateway'
  );
--> statement-breakpoint
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
    NOW(),
    NOW()
FROM vm0_restore_claude_fable_5_policy_sources
WHERE "route_rank" = 1
ON CONFLICT ("org_id", "model") DO NOTHING;
