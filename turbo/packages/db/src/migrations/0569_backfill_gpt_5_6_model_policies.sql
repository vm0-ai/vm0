-- Custom SQL migration file, put your code below! --
WITH target_models("model") AS (
  VALUES
    ('gpt-5.6-sol'),
    ('gpt-5.6-terra'),
    ('gpt-5.6-luna')
),
orgs_with_policies AS (
  SELECT DISTINCT "org_id"
  FROM "org_model_policies"
),
gpt_55_sources AS (
  SELECT
    "org_id",
    "default_provider_type",
    "credential_scope",
    "model_provider_id",
    "created_by_user_id",
    "updated_by_user_id",
    row_number() OVER (
      PARTITION BY "org_id"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id"
    ) AS "route_rank"
  FROM "org_model_policies"
  WHERE "model" = 'gpt-5.5'
),
chosen_sources AS (
  SELECT
    "orgs"."org_id",
    CASE
      WHEN "source"."default_provider_type" = 'openai-api-key'
        AND "source"."credential_scope" = 'org'
        AND "source"."model_provider_id" IS NOT NULL
        AND "provider"."id" IS NOT NULL
        THEN 'openai-api-key'
      ELSE 'vm0'
    END AS "default_provider_type",
    'org' AS "credential_scope",
    CASE
      WHEN "source"."default_provider_type" = 'openai-api-key'
        AND "source"."credential_scope" = 'org'
        AND "source"."model_provider_id" IS NOT NULL
        AND "provider"."id" IS NOT NULL
        THEN "source"."model_provider_id"
      ELSE NULL
    END AS "model_provider_id",
    "source"."created_by_user_id",
    "source"."updated_by_user_id"
  FROM "orgs_with_policies" AS "orgs"
  LEFT JOIN "gpt_55_sources" AS "source"
    ON "source"."org_id" = "orgs"."org_id"
   AND "source"."route_rank" = 1
  LEFT JOIN "model_providers" AS "provider"
    ON "provider"."id" = "source"."model_provider_id"
   AND "provider"."org_id" = "source"."org_id"
   AND "provider"."user_id" = '__org__'
   AND "provider"."type" = 'openai-api-key'
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
  "source"."org_id",
  "target"."model",
  false AS "is_default",
  "source"."default_provider_type",
  "source"."credential_scope",
  "source"."model_provider_id",
  "source"."created_by_user_id",
  "source"."updated_by_user_id",
  now(),
  now()
FROM "chosen_sources" AS "source"
CROSS JOIN "target_models" AS "target"
ON CONFLICT ("org_id", "model") DO NOTHING;
