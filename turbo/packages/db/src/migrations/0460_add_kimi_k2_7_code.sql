INSERT INTO "usage_pricing" (
    "kind",
    "provider",
    "category",
    "unit_price",
    "unit_size"
)
VALUES
    ('model', 'kimi-k2.7-code', 'tokens.cache_creation', 1140, 1000000),
    ('model', 'kimi-k2.7-code', 'tokens.cache_read', 192, 1000000),
    ('model', 'kimi-k2.7-code', 'tokens.input', 1140, 1000000),
    ('model', 'kimi-k2.7-code', 'tokens.output', 4800, 1000000)
ON CONFLICT ("kind", "provider", "category") DO UPDATE
SET
    "unit_price" = EXCLUDED."unit_price",
    "unit_size" = EXCLUDED."unit_size",
    "updated_at" = NOW();
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp.vm0_kimi_k2_7_policy_sources;
--> statement-breakpoint
CREATE TEMP TABLE vm0_kimi_k2_7_policy_sources ON COMMIT DROP AS
SELECT
    "org_id",
    "is_default",
    CASE
        WHEN "default_provider_type" = 'moonshot-api-key' THEN 'moonshot-api-key'
        ELSE 'vm0'
    END AS "default_provider_type",
    CASE
        WHEN "default_provider_type" = 'moonshot-api-key' THEN "credential_scope"
        ELSE 'org'
    END AS "credential_scope",
    CASE
        WHEN "default_provider_type" = 'moonshot-api-key' THEN "model_provider_id"
        ELSE NULL
    END AS "model_provider_id",
    "created_by_user_id",
    "updated_by_user_id"
FROM "org_model_policies"
WHERE "model" = 'kimi-k2.6';
--> statement-breakpoint
UPDATE "org_model_policies"
SET
    "is_default" = false,
    "updated_at" = NOW()
WHERE "model" IN ('kimi-k2.6', 'kimi-k2.5')
  AND "is_default" = true;
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
    'kimi-k2.7-code' AS "model",
    "is_default",
    "default_provider_type",
    "credential_scope",
    "model_provider_id",
    "created_by_user_id",
    "updated_by_user_id",
    NOW(),
    NOW()
FROM vm0_kimi_k2_7_policy_sources
ON CONFLICT ("org_id", "model") DO UPDATE
SET
    "is_default" = "org_model_policies"."is_default" OR EXCLUDED."is_default",
    "default_provider_type" = CASE
        WHEN EXCLUDED."is_default" OR NOT "org_model_policies"."is_default" THEN EXCLUDED."default_provider_type"
        ELSE "org_model_policies"."default_provider_type"
    END,
    "credential_scope" = CASE
        WHEN EXCLUDED."is_default" OR NOT "org_model_policies"."is_default" THEN EXCLUDED."credential_scope"
        ELSE "org_model_policies"."credential_scope"
    END,
    "model_provider_id" = CASE
        WHEN EXCLUDED."is_default" OR NOT "org_model_policies"."is_default" THEN EXCLUDED."model_provider_id"
        ELSE "org_model_policies"."model_provider_id"
    END,
    "created_by_user_id" = COALESCE("org_model_policies"."created_by_user_id", EXCLUDED."created_by_user_id"),
    "updated_by_user_id" = COALESCE(EXCLUDED."updated_by_user_id", "org_model_policies"."updated_by_user_id"),
    "updated_at" = NOW();
--> statement-breakpoint
DELETE FROM "org_model_policies"
WHERE "model" IN ('kimi-k2.6', 'kimi-k2.5');
--> statement-breakpoint
UPDATE "model_providers"
SET
    "selected_model" = 'kimi-k2.7-code',
    "updated_at" = NOW()
WHERE "type" IN ('vm0', 'moonshot-api-key')
  AND "selected_model" IN (
    'kimi-k2.6',
    'kimi-k2.5',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.5'
  );
--> statement-breakpoint
UPDATE "model_providers"
SET
    "selected_model" = NULL,
    "updated_at" = NOW()
WHERE "type" NOT IN ('vm0', 'moonshot-api-key')
  AND "selected_model" IN (
    'kimi-k2.6',
    'kimi-k2.5',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.5'
  );
--> statement-breakpoint
UPDATE "zero_agents"
SET
    "selected_model" = 'kimi-k2.7-code',
    "updated_at" = NOW()
WHERE "selected_model" IN (
    'kimi-k2.6',
    'kimi-k2.5',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.5'
);
--> statement-breakpoint
UPDATE "chat_threads"
SET
    "selected_model" = 'kimi-k2.7-code',
    "updated_at" = NOW()
WHERE "selected_model" IN (
    'kimi-k2.6',
    'kimi-k2.5',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.5'
);
--> statement-breakpoint
UPDATE "org_members_metadata"
SET
    "selected_model" = 'kimi-k2.7-code',
    "updated_at" = NOW()
WHERE "selected_model" IN (
    'kimi-k2.6',
    'kimi-k2.5',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.5'
);
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp.vm0_kimi_k2_7_policy_sources;
