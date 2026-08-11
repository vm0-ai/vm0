-- Custom SQL migration file; preserved from PR #26338 after migration renumbering.
-- Stage 2 of the run-model retirement migrates current selections only.
-- Historical runs, events, usage rows, and thread pins remain byte-identical;
-- chat_threads are reconciled lazily by the API compatibility path.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.vm0_retired_model_replacement_0901(
  source_model text,
  restricted_vm0_models boolean
) RETURNS text AS $$
DECLARE
  normalized_model text;
  replacement_model text;
BEGIN
  normalized_model := lower(btrim(source_model));
  replacement_model := CASE
    WHEN normalized_model IN ('gpt-5.5', 'openai/gpt-5.5')
      THEN 'gpt-5.6-sol'
    WHEN normalized_model IN (
      'claude-opus-4-7',
      'anthropic/claude-opus-4.7',
      'anthropic/claude-opus-4-7',
      'claude-opus-4-6',
      'anthropic/claude-opus-4.6',
      'anthropic/claude-opus-4-6'
    ) THEN 'claude-opus-4-8'
    WHEN normalized_model IN (
      'claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-sonnet-4-6'
    ) THEN 'claude-sonnet-5'
    WHEN normalized_model IN ('kimi-k3', 'kimi-k2.7-code')
      THEN 'deepseek-v4-flash'
    WHEN normalized_model IN ('minimax-m3', 'minimax/minimax-m3')
      THEN 'deepseek-v4-flash'
    WHEN normalized_model LIKE 'glm-%'
      OR normalized_model LIKE 'z-ai/%'
      OR normalized_model LIKE 'zai/%'
      THEN 'deepseek-v4-flash'
    WHEN normalized_model IN ('mimo-v2.5', 'xiaomi/mimo-v2.5')
      THEN 'deepseek-v4-flash'
    WHEN normalized_model IN ('hy3-preview', 'tencent/hy3-preview')
      THEN 'deepseek-v4-flash'
    ELSE NULL
  END;

  IF replacement_model IS NULL THEN
    RETURN NULL;
  END IF;
  IF COALESCE(restricted_vm0_models, false) THEN
    RETURN 'deepseek-v4-flash';
  END IF;
  RETURN replacement_model;
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.vm0_provider_supports_model_0901(
  target_model text,
  provider_type text
) RETURNS boolean AS $$
BEGIN
  RETURN CASE target_model
    WHEN 'gpt-5.6-sol' THEN provider_type IN (
      'vm0',
      'openai-api-key',
      'codex-oauth-token',
      'openrouter-codex',
      'vercel-ai-gateway-codex'
    )
    WHEN 'claude-opus-4-8' THEN provider_type IN (
      'vm0',
      'claude-code-oauth-token',
      'anthropic-api-key',
      'openrouter-api-key',
      'vercel-ai-gateway'
    )
    WHEN 'claude-sonnet-5' THEN provider_type IN (
      'vm0',
      'claude-code-oauth-token',
      'anthropic-api-key',
      'openrouter-api-key',
      'vercel-ai-gateway'
    )
    WHEN 'deepseek-v4-flash' THEN provider_type IN ('vm0', 'deepseek')
    ELSE false
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.vm0_provider_runtime_model_0901(
  target_model text,
  provider_type text
) RETURNS text AS $$
BEGIN
  IF provider_type IN ('openrouter-codex', 'vercel-ai-gateway-codex')
    AND target_model = 'gpt-5.6-sol'
  THEN
    RETURN 'openai/gpt-5.6-sol';
  END IF;
  IF provider_type IN ('openrouter-api-key', 'vercel-ai-gateway')
    AND target_model = 'claude-opus-4-8'
  THEN
    RETURN 'anthropic/claude-opus-4.8';
  END IF;
  IF provider_type IN ('openrouter-api-key', 'vercel-ai-gateway')
    AND target_model = 'claude-sonnet-5'
  THEN
    RETURN 'anthropic/claude-sonnet-5';
  END IF;
  RETURN target_model;
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.vm0_policy_route_supports_model_0901(
  target_model text,
  route_org_id text,
  provider_type text,
  credential_scope text,
  model_provider_id uuid,
  model_provider_surface_id uuid
) RETURNS boolean AS $$
BEGIN
  IF model_provider_surface_id IS NOT NULL THEN
    IF credential_scope <> 'org' OR model_provider_id IS NOT NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1
      FROM "model_provider_surfaces" AS "surface"
      INNER JOIN "model_provider_connections" AS "connection"
        ON "connection"."id" = "surface"."connection_id"
      WHERE "surface"."id" = model_provider_surface_id
        AND "connection"."org_id" = route_org_id
        AND jsonb_typeof("surface"."model_mappings" -> target_model) = 'string'
        AND (
          (
            "surface"."protocol" = 'anthropic-messages'
            AND provider_type = 'vercel-ai-gateway'
            AND target_model IN ('claude-opus-4-8', 'claude-sonnet-5')
          )
          OR (
            "surface"."protocol" = 'openai-responses'
            AND provider_type = 'vercel-ai-gateway-codex'
            AND target_model IN ('gpt-5.6-sol', 'deepseek-v4-flash')
          )
        )
    );
  END IF;

  IF model_provider_id IS NOT NULL AND model_provider_surface_id IS NOT NULL THEN
    RETURN false;
  END IF;
  IF NOT pg_temp.vm0_provider_supports_model_0901(
    target_model,
    provider_type
  ) THEN
    RETURN false;
  END IF;
  IF credential_scope = 'member' THEN
    RETURN provider_type IN (
      'claude-code-oauth-token',
      'codex-oauth-token'
    ) AND model_provider_id IS NULL;
  END IF;
  IF credential_scope <> 'org' THEN
    RETURN false;
  END IF;
  IF provider_type = 'vm0' THEN
    RETURN model_provider_id IS NULL;
  END IF;
  IF provider_type IN ('claude-code-oauth-token', 'codex-oauth-token')
    OR model_provider_id IS NULL
  THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM "model_providers" AS "provider"
    WHERE "provider"."id" = model_provider_id
      AND "provider"."org_id" = route_org_id
      AND "provider"."user_id" = '__org__'
      AND "provider"."type" = provider_type
  );
END;
$$ LANGUAGE plpgsql STABLE;--> statement-breakpoint

DO $$
DECLARE
  policy_count bigint;
  member_count bigint;
  thread_count bigint;
  agent_count bigint;
  provider_count bigint;
BEGIN
  SELECT count(*) INTO policy_count
  FROM "org_model_policies" AS "policy"
  WHERE pg_temp.vm0_retired_model_replacement_0901(
    "policy"."model",
    false
  ) IS NOT NULL;

  SELECT count(*) INTO member_count
  FROM "org_members_metadata" AS "member"
  WHERE pg_temp.vm0_retired_model_replacement_0901(
    "member"."selected_model",
    false
  ) IS NOT NULL;

  SELECT count(*) INTO thread_count
  FROM "chat_threads" AS "thread"
  WHERE pg_temp.vm0_retired_model_replacement_0901(
    "thread"."selected_model",
    false
  ) IS NOT NULL;

  SELECT count(*) INTO agent_count
  FROM "zero_agents" AS "agent"
  LEFT JOIN "model_providers" AS "provider"
    ON "provider"."id" = "agent"."model_provider_id"
  WHERE "provider"."type" = 'zai-api-key'
    OR pg_temp.vm0_retired_model_replacement_0901(
      "agent"."selected_model",
      false
    ) IS NOT NULL;

  SELECT count(*) INTO provider_count
  FROM "model_providers" AS "provider"
  WHERE "provider"."type" = 'zai-api-key'
    OR pg_temp.vm0_retired_model_replacement_0901(
      "provider"."selected_model",
      false
    ) IS NOT NULL;

  RAISE NOTICE 'Retired run-model migration candidates: policies=%, members=%, lazy_threads=%, agents=%, providers=%',
    policy_count,
    member_count,
    thread_count,
    agent_count,
    provider_count;
END;
$$;--> statement-breakpoint

-- Prevent policy writers from racing default transfer or replacement inserts.
-- Stage 1 admission and persistence guards must be live before this migration.
LOCK TABLE "org_model_policies" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

CREATE TEMPORARY TABLE "retired_org_policy_candidates_0901"
ON COMMIT DROP
AS
SELECT DISTINCT ON (
  "policy"."org_id",
  "mapped"."replacement_model"
)
  "policy"."org_id",
  "mapped"."replacement_model",
  "policy"."is_default" AS "source_is_default",
  COALESCE("entitlement"."restricted_vm0_models", false) AS "restricted",
  CASE
    WHEN COALESCE("entitlement"."restricted_vm0_models", false)
      OR NOT "route"."can_preserve"
      THEN 'vm0'
    ELSE "policy"."default_provider_type"
  END AS "default_provider_type",
  CASE
    WHEN COALESCE("entitlement"."restricted_vm0_models", false)
      OR NOT "route"."can_preserve"
      THEN 'org'
    ELSE "policy"."credential_scope"
  END AS "credential_scope",
  CASE
    WHEN COALESCE("entitlement"."restricted_vm0_models", false)
      OR NOT "route"."can_preserve"
      THEN NULL
    ELSE "policy"."model_provider_id"
  END AS "model_provider_id",
  CASE
    WHEN COALESCE("entitlement"."restricted_vm0_models", false)
      OR NOT "route"."can_preserve"
      THEN NULL
    ELSE "policy"."model_provider_surface_id"
  END AS "model_provider_surface_id",
  "policy"."created_by_user_id",
  "policy"."updated_by_user_id"
FROM "org_model_policies" AS "policy"
LEFT JOIN "org_plan_entitlements" AS "entitlement"
  ON "entitlement"."org_id" = "policy"."org_id"
CROSS JOIN LATERAL (
  SELECT pg_temp.vm0_retired_model_replacement_0901(
    "policy"."model",
    COALESCE("entitlement"."restricted_vm0_models", false)
  ) AS "replacement_model"
) AS "mapped"
CROSS JOIN LATERAL (
  SELECT pg_temp.vm0_policy_route_supports_model_0901(
    "mapped"."replacement_model",
    "policy"."org_id",
    "policy"."default_provider_type",
    "policy"."credential_scope",
    "policy"."model_provider_id",
    "policy"."model_provider_surface_id"
  ) AS "can_preserve"
) AS "route"
WHERE "mapped"."replacement_model" IS NOT NULL
ORDER BY
  "policy"."org_id",
  "mapped"."replacement_model",
  "policy"."is_default" DESC,
  "route"."can_preserve" DESC,
  "policy"."updated_at" DESC,
  "policy"."id";--> statement-breakpoint

-- Release the partial unique default slot before transferring it to the
-- replacement policy in the same transaction.
UPDATE "org_model_policies" AS "policy"
SET "is_default" = false,
    "updated_at" = NOW()
WHERE "policy"."is_default" = true
  AND pg_temp.vm0_retired_model_replacement_0901(
    "policy"."model",
    false
  ) IS NOT NULL;--> statement-breakpoint

-- Merge into an existing replacement policy. Keep an already-valid target
-- route unless this is a restricted org, where the replacement is always the
-- VM0-managed DeepSeek route.
UPDATE "org_model_policies" AS "target"
SET "is_default" = "target"."is_default" OR "candidate"."source_is_default",
    "default_provider_type" = CASE
      WHEN "candidate"."restricted"
        OR NOT pg_temp.vm0_policy_route_supports_model_0901(
          "target"."model",
          "target"."org_id",
          "target"."default_provider_type",
          "target"."credential_scope",
          "target"."model_provider_id",
          "target"."model_provider_surface_id"
        )
        THEN "candidate"."default_provider_type"
      ELSE "target"."default_provider_type"
    END,
    "credential_scope" = CASE
      WHEN "candidate"."restricted"
        OR NOT pg_temp.vm0_policy_route_supports_model_0901(
          "target"."model",
          "target"."org_id",
          "target"."default_provider_type",
          "target"."credential_scope",
          "target"."model_provider_id",
          "target"."model_provider_surface_id"
        )
        THEN "candidate"."credential_scope"
      ELSE "target"."credential_scope"
    END,
    "model_provider_id" = CASE
      WHEN "candidate"."restricted"
        OR NOT pg_temp.vm0_policy_route_supports_model_0901(
          "target"."model",
          "target"."org_id",
          "target"."default_provider_type",
          "target"."credential_scope",
          "target"."model_provider_id",
          "target"."model_provider_surface_id"
        )
        THEN "candidate"."model_provider_id"
      ELSE "target"."model_provider_id"
    END,
    "model_provider_surface_id" = CASE
      WHEN "candidate"."restricted"
        OR NOT pg_temp.vm0_policy_route_supports_model_0901(
          "target"."model",
          "target"."org_id",
          "target"."default_provider_type",
          "target"."credential_scope",
          "target"."model_provider_id",
          "target"."model_provider_surface_id"
        )
        THEN "candidate"."model_provider_surface_id"
      ELSE "target"."model_provider_surface_id"
    END,
    "updated_by_user_id" = COALESCE(
      "candidate"."updated_by_user_id",
      "target"."updated_by_user_id"
    ),
    "updated_at" = NOW()
FROM "retired_org_policy_candidates_0901" AS "candidate"
WHERE "target"."org_id" = "candidate"."org_id"
  AND "target"."model" = "candidate"."replacement_model";--> statement-breakpoint

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
  "candidate"."org_id",
  "candidate"."replacement_model",
  "candidate"."source_is_default",
  "candidate"."default_provider_type",
  "candidate"."credential_scope",
  "candidate"."model_provider_id",
  "candidate"."model_provider_surface_id",
  "candidate"."created_by_user_id",
  "candidate"."updated_by_user_id",
  NOW(),
  NOW()
FROM "retired_org_policy_candidates_0901" AS "candidate"
ON CONFLICT ("org_id", "model") DO NOTHING;--> statement-breakpoint

DELETE FROM "org_model_policies" AS "policy"
WHERE pg_temp.vm0_retired_model_replacement_0901(
  "policy"."model",
  false
) IS NOT NULL;--> statement-breakpoint

WITH "member_candidates" AS (
  SELECT
    "member"."org_id",
    "member"."user_id",
    pg_temp.vm0_retired_model_replacement_0901(
      "member"."selected_model",
      COALESCE("entitlement"."restricted_vm0_models", false)
    ) AS "replacement_model"
  FROM "org_members_metadata" AS "member"
  LEFT JOIN "org_plan_entitlements" AS "entitlement"
    ON "entitlement"."org_id" = "member"."org_id"
)
UPDATE "org_members_metadata" AS "member"
SET "selected_model" = "candidate"."replacement_model",
    "service_tier" = CASE
      WHEN "candidate"."replacement_model" = 'gpt-5.6-sol'
        THEN "member"."service_tier"
      ELSE NULL
    END,
    "updated_at" = NOW()
FROM "member_candidates" AS "candidate"
WHERE "member"."org_id" = "candidate"."org_id"
  AND "member"."user_id" = "candidate"."user_id"
  AND "candidate"."replacement_model" IS NOT NULL;--> statement-breakpoint

WITH "provider_candidates" AS (
  SELECT
    "provider"."id",
    "provider"."type",
    pg_temp.vm0_retired_model_replacement_0901(
      CASE
        WHEN "provider"."type" = 'zai-api-key' THEN 'glm-5.2'
        ELSE "provider"."selected_model"
      END,
      COALESCE("entitlement"."restricted_vm0_models", false)
    ) AS "replacement_model"
  FROM "model_providers" AS "provider"
  LEFT JOIN "org_plan_entitlements" AS "entitlement"
    ON "entitlement"."org_id" = "provider"."org_id"
  WHERE "provider"."type" = 'zai-api-key'
    OR pg_temp.vm0_retired_model_replacement_0901(
      "provider"."selected_model",
      false
    ) IS NOT NULL
)
UPDATE "model_providers" AS "provider"
SET "selected_model" = CASE
      WHEN pg_temp.vm0_provider_supports_model_0901(
        "candidate"."replacement_model",
        "candidate"."type"
      ) THEN pg_temp.vm0_provider_runtime_model_0901(
        "candidate"."replacement_model",
        "candidate"."type"
      )
      ELSE NULL
    END,
    "is_default" = CASE
      WHEN pg_temp.vm0_provider_supports_model_0901(
        "candidate"."replacement_model",
        "candidate"."type"
      ) THEN "provider"."is_default"
      ELSE false
    END,
    "updated_at" = NOW()
FROM "provider_candidates" AS "candidate"
WHERE "provider"."id" = "candidate"."id";--> statement-breakpoint

WITH "agent_candidates" AS (
  SELECT
    "agent"."id",
    "agent"."model_provider_id",
    "provider"."type" AS "provider_type",
    pg_temp.vm0_retired_model_replacement_0901(
      CASE
        WHEN "provider"."type" = 'zai-api-key' THEN 'glm-5.2'
        ELSE "agent"."selected_model"
      END,
      COALESCE("entitlement"."restricted_vm0_models", false)
    ) AS "replacement_model"
  FROM "zero_agents" AS "agent"
  LEFT JOIN "model_providers" AS "provider"
    ON "provider"."id" = "agent"."model_provider_id"
  LEFT JOIN "org_plan_entitlements" AS "entitlement"
    ON "entitlement"."org_id" = "agent"."org_id"
  WHERE "provider"."type" = 'zai-api-key'
    OR pg_temp.vm0_retired_model_replacement_0901(
      "agent"."selected_model",
      false
    ) IS NOT NULL
)
UPDATE "zero_agents" AS "agent"
SET "selected_model" = CASE
      WHEN "candidate"."model_provider_id" IS NULL
        OR pg_temp.vm0_provider_supports_model_0901(
          "candidate"."replacement_model",
          "candidate"."provider_type"
        ) THEN "candidate"."replacement_model"
      ELSE NULL
    END,
    "model_provider_id" = CASE
      WHEN "candidate"."model_provider_id" IS NULL
        OR pg_temp.vm0_provider_supports_model_0901(
          "candidate"."replacement_model",
          "candidate"."provider_type"
        ) THEN "candidate"."model_provider_id"
      ELSE NULL
    END,
    "updated_at" = NOW()
FROM "agent_candidates" AS "candidate"
WHERE "agent"."id" = "candidate"."id";--> statement-breakpoint

DO $$
DECLARE
  lazy_thread_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "org_model_policies" AS "policy"
    WHERE pg_temp.vm0_retired_model_replacement_0901(
      "policy"."model",
      false
    ) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Retired org model policies remain after migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_members_metadata" AS "member"
    WHERE pg_temp.vm0_retired_model_replacement_0901(
      "member"."selected_model",
      false
    ) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Retired member model preferences remain after migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "model_providers" AS "provider"
    WHERE pg_temp.vm0_retired_model_replacement_0901(
      "provider"."selected_model",
      false
    ) IS NOT NULL
      OR ("provider"."type" = 'zai-api-key' AND "provider"."is_default")
  ) THEN
    RAISE EXCEPTION 'Retired provider selections or Z.AI defaults remain after migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "zero_agents" AS "agent"
    LEFT JOIN "model_providers" AS "provider"
      ON "provider"."id" = "agent"."model_provider_id"
    WHERE pg_temp.vm0_retired_model_replacement_0901(
      "agent"."selected_model",
      false
    ) IS NOT NULL
      OR "provider"."type" = 'zai-api-key'
  ) THEN
    RAISE EXCEPTION 'Retired agent selections or Z.AI routes remain after migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "retired_org_policy_candidates_0901" AS "candidate"
    LEFT JOIN "org_model_policies" AS "target"
      ON "target"."org_id" = "candidate"."org_id"
      AND "target"."model" = "candidate"."replacement_model"
    WHERE "target"."id" IS NULL
      OR (
        "candidate"."source_is_default"
        AND NOT "target"."is_default"
      )
      OR NOT pg_temp.vm0_policy_route_supports_model_0901(
        "target"."model",
        "target"."org_id",
        "target"."default_provider_type",
        "target"."credential_scope",
        "target"."model_provider_id",
        "target"."model_provider_surface_id"
      )
  ) THEN
    RAISE EXCEPTION 'Replacement org model policies failed postcondition checks';
  END IF;

  SELECT count(*) INTO lazy_thread_count
  FROM "chat_threads" AS "thread"
  WHERE pg_temp.vm0_retired_model_replacement_0901(
    "thread"."selected_model",
    false
  ) IS NOT NULL;

  RAISE NOTICE 'Retired run-model migration complete; % thread pins remain for lazy reconciliation',
    lazy_thread_count;
END;
$$;
