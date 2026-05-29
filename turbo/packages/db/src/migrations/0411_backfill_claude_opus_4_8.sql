-- Mirror existing Claude Opus 4.7 org policies for Claude Opus 4.8.
-- Pricing and VM0 API key rows already exist in production, so this migration
-- only backfills org-level model routes and keeps existing defaults unchanged.

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
