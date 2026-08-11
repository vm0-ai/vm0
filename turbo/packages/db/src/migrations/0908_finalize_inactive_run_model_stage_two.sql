-- Complete the approved Stage 2 cut after 0905 migrated the original
-- policy, preference, provider, and agent state. GPT 5.5 and Claude Sonnet
-- 4.6 are intentionally active again. Historical runs, chat events, usage
-- events, and snapshots remain unchanged.
-- Member preferences already projected by 0905 cannot be attributed back to
-- their source model safely, so this follow-up does not guess at a reversal.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.stage2_aggressive_replacement_0908(
  raw_model text,
  provider_type text,
  restricted_vm0_models boolean
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN provider_type IN (
      'minimax-api-key',
      'moonshot-api-key',
      'zai-api-key'
    ) THEN 'deepseek-v4-flash'
    WHEN raw_model IS NULL THEN NULL
    WHEN lower(trim(raw_model)) IN (
      'claude-opus-4-7',
      'anthropic/claude-opus-4.7',
      'anthropic/claude-opus-4-7',
      'claude-opus-4-6',
      'anthropic/claude-opus-4.6',
      'anthropic/claude-opus-4-6'
    ) THEN CASE
      WHEN restricted_vm0_models THEN 'deepseek-v4-flash'
      ELSE 'claude-opus-4-8'
    END
    WHEN lower(trim(raw_model)) IN (
      'kimi-k3',
      'kimi-k2.7-code',
      'minimax-m3',
      'minimax/minimax-m3',
      'mimo-v2.5',
      'xiaomi/mimo-v2.5',
      'hy3-preview',
      'tencent/hy3-preview'
    ) THEN 'deepseek-v4-flash'
    WHEN lower(trim(raw_model)) LIKE 'z-ai/%'
      OR lower(trim(raw_model)) LIKE 'zai/%'
      OR lower(trim(raw_model)) LIKE 'glm-%'
    THEN 'deepseek-v4-flash'
    ELSE NULL
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.stage2_reopened_model_0908(
  replacement_model text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE replacement_model
    WHEN 'gpt-5.6-sol' THEN 'gpt-5.5'
    WHEN 'claude-sonnet-5' THEN 'claude-sonnet-4-6'
    ELSE NULL
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.stage2_provider_supports_model_0908(
  target_model text,
  provider_type text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE target_model
    WHEN 'gpt-5.5' THEN provider_type IN (
      'vm0',
      'openai-api-key',
      'codex-oauth-token',
      'openrouter-codex',
      'vercel-ai-gateway-codex'
    )
    WHEN 'claude-sonnet-4-6' THEN provider_type IN (
      'vm0',
      'claude-code-oauth-token',
      'anthropic-api-key',
      'openrouter-api-key',
      'vercel-ai-gateway'
    )
    ELSE false
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.stage2_policy_route_supports_model_0908(
  target_model text,
  route_org_id text,
  provider_type text,
  credential_scope text,
  model_provider_id uuid,
  model_provider_surface_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF model_provider_surface_id IS NOT NULL THEN
    IF credential_scope <> 'org' OR model_provider_id IS NOT NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1
      FROM "model_provider_surfaces" AS surface
      INNER JOIN "model_provider_connections" AS connection
        ON connection."id" = surface."connection_id"
      WHERE surface."id" = model_provider_surface_id
        AND connection."org_id" = route_org_id
        AND jsonb_typeof(
          surface."model_mappings" -> target_model
        ) = 'string'
        AND (
          (
            surface."protocol" = 'anthropic-messages'
            AND provider_type = 'vercel-ai-gateway'
            AND target_model = 'claude-sonnet-4-6'
          ) OR (
            surface."protocol" = 'openai-responses'
            AND provider_type = 'vercel-ai-gateway-codex'
            AND target_model = 'gpt-5.5'
          )
        )
    );
  END IF;

  IF model_provider_id IS NOT NULL
    AND model_provider_surface_id IS NOT NULL
  THEN
    RETURN false;
  END IF;
  IF NOT pg_temp.stage2_provider_supports_model_0908(
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
    FROM "model_providers" AS provider
    WHERE provider."id" = model_provider_id
      AND provider."org_id" = route_org_id
      AND provider."user_id" = '__org__'
      AND provider."type" = provider_type
  );
END;
$$;--> statement-breakpoint

DO $$
DECLARE
  policy_count bigint;
  thread_count bigint;
  provider_count bigint;
  pricing_count bigint;
BEGIN
  SELECT count(*) INTO policy_count
  FROM "org_model_policies" AS policy
  LEFT JOIN "org_plan_entitlements" AS entitlement
    ON entitlement."org_id" = policy."org_id"
  WHERE pg_temp.stage2_reopened_model_0908(policy."model") IS NOT NULL
    AND NOT coalesce(entitlement."restricted_vm0_models", false)
    AND NOT EXISTS (
      SELECT 1
      FROM "org_model_policies" AS reopened
      WHERE reopened."org_id" = policy."org_id"
        AND reopened."model" =
          pg_temp.stage2_reopened_model_0908(policy."model")
    );

  SELECT count(*) INTO thread_count
  FROM "chat_threads" AS thread
  LEFT JOIN "model_providers" AS provider
    ON provider."id" = thread."model_provider_id"
  WHERE pg_temp.stage2_aggressive_replacement_0908(
    thread."selected_model",
    coalesce(thread."model_provider_type", provider."type"),
    false
  ) IS NOT NULL;

  SELECT count(*) INTO provider_count
  FROM "model_providers" AS provider
  WHERE provider."type" IN (
    'minimax-api-key',
    'moonshot-api-key',
    'zai-api-key'
  );

  SELECT count(*) INTO pricing_count
  FROM "usage_pricing" AS pricing
  WHERE pricing."kind" = 'model'
    AND (
      pg_temp.stage2_aggressive_replacement_0908(
        pricing."provider",
        NULL,
        false
      ) IS NOT NULL
      OR lower(trim(pricing."provider")) IN ('kimi-k2.6', 'kimi-k2.5')
    );

  RAISE NOTICE
    'Stage 2 follow-up candidates: reopened_policies=%, eager_threads=%, incompatible_providers=%, pricing=%',
    policy_count,
    thread_count,
    provider_count,
    pricing_count;
END;
$$;--> statement-breakpoint

-- Prevent policy writers from racing the reopened-policy inserts.
LOCK TABLE "org_model_policies" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

CREATE TEMP TABLE "stage2_reopened_policy_candidates_0908"
ON COMMIT DROP
AS
SELECT
  policy."org_id",
  pg_temp.stage2_reopened_model_0908(policy."model") AS "model",
  policy."default_provider_type",
  policy."credential_scope",
  policy."model_provider_id",
  policy."model_provider_surface_id",
  policy."created_by_user_id",
  policy."updated_by_user_id",
  coalesce(
    entitlement."status" = 'active'
      AND NOT entitlement."support_byok",
    false
  ) AS "byok_blocked",
  pg_temp.stage2_policy_route_supports_model_0908(
    pg_temp.stage2_reopened_model_0908(policy."model"),
    policy."org_id",
    policy."default_provider_type",
    policy."credential_scope",
    policy."model_provider_id",
    policy."model_provider_surface_id"
  ) AS "route_compatible"
FROM "org_model_policies" AS policy
LEFT JOIN "org_plan_entitlements" AS entitlement
  ON entitlement."org_id" = policy."org_id"
WHERE pg_temp.stage2_reopened_model_0908(policy."model") IS NOT NULL
  AND NOT coalesce(entitlement."restricted_vm0_models", false)
  AND NOT EXISTS (
    SELECT 1
    FROM "org_model_policies" AS reopened
    WHERE reopened."org_id" = policy."org_id"
      AND reopened."model" =
        pg_temp.stage2_reopened_model_0908(policy."model")
  );--> statement-breakpoint

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
  candidate."org_id",
  candidate."model",
  false,
  CASE
    WHEN candidate."byok_blocked" OR NOT candidate."route_compatible"
      THEN 'vm0'
    ELSE candidate."default_provider_type"
  END,
  CASE
    WHEN candidate."byok_blocked" OR NOT candidate."route_compatible"
      THEN 'org'
    ELSE candidate."credential_scope"
  END,
  CASE
    WHEN candidate."byok_blocked" OR NOT candidate."route_compatible"
      THEN NULL
    ELSE candidate."model_provider_id"
  END,
  CASE
    WHEN candidate."byok_blocked" OR NOT candidate."route_compatible"
      THEN NULL
    ELSE candidate."model_provider_surface_id"
  END,
  candidate."created_by_user_id",
  candidate."updated_by_user_id",
  NOW(),
  NOW()
FROM "stage2_reopened_policy_candidates_0908" AS candidate
ON CONFLICT ("org_id", "model") DO NOTHING;--> statement-breakpoint

WITH candidates AS (
  SELECT
    thread."id",
    pg_temp.stage2_aggressive_replacement_0908(
      thread."selected_model",
      coalesce(thread."model_provider_type", provider."type"),
      coalesce(entitlement."restricted_vm0_models", false)
    ) AS "replacement_model"
  FROM "chat_threads" AS thread
  INNER JOIN "agent_composes" AS compose
    ON compose."id" = thread."agent_compose_id"
  LEFT JOIN "model_providers" AS provider
    ON provider."id" = thread."model_provider_id"
  LEFT JOIN "org_plan_entitlements" AS entitlement
    ON entitlement."org_id" = compose."org_id"
)
UPDATE "chat_threads" AS thread
SET "selected_model" = candidate."replacement_model",
    "model_provider_id" = NULL,
    "model_provider_type" = NULL,
    "model_provider_credential_scope" = NULL,
    "codex_service_tier" = NULL
FROM candidates AS candidate
WHERE candidate."id" = thread."id"
  AND candidate."replacement_model" IS NOT NULL;--> statement-breakpoint

CREATE TEMP TABLE "stage2_incompatible_provider_candidates_0908"
ON COMMIT DROP
AS
SELECT
  provider."id",
  provider."org_id",
  provider."user_id",
  provider."secret_id"
FROM "model_providers" AS provider
WHERE provider."type" IN (
  'minimax-api-key',
  'moonshot-api-key',
  'zai-api-key'
);--> statement-breakpoint

UPDATE "org_model_policies" AS policy
SET "default_provider_type" = 'vm0',
    "credential_scope" = 'org',
    "model_provider_id" = NULL,
    "model_provider_surface_id" = NULL,
    "updated_at" = NOW()
WHERE policy."default_provider_type" IN (
    'minimax-api-key',
    'moonshot-api-key',
    'zai-api-key'
  )
  OR EXISTS (
    SELECT 1
    FROM "stage2_incompatible_provider_candidates_0908" AS candidate
    WHERE candidate."id" = policy."model_provider_id"
  );--> statement-breakpoint

UPDATE "zero_agents" AS agent
SET "selected_model" = 'deepseek-v4-flash',
    "model_provider_id" = NULL,
    "updated_at" = NOW()
WHERE EXISTS (
  SELECT 1
  FROM "stage2_incompatible_provider_candidates_0908" AS candidate
  WHERE candidate."id" = agent."model_provider_id"
);--> statement-breakpoint

UPDATE "model_providers" AS provider
SET "is_default" = false,
    "updated_at" = NOW()
FROM "stage2_incompatible_provider_candidates_0908" AS candidate
WHERE provider."id" = candidate."id"
  AND provider."is_default";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "stage2_incompatible_provider_candidates_0908" AS candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM "model_providers" AS default_provider
      WHERE default_provider."org_id" = candidate."org_id"
        AND default_provider."user_id" = candidate."user_id"
        AND default_provider."is_default"
    )
      AND NOT EXISTS (
        SELECT 1
        FROM "model_providers" AS vm0_peer
        WHERE vm0_peer."org_id" = candidate."org_id"
          AND vm0_peer."user_id" = candidate."user_id"
          AND vm0_peer."type" = 'vm0'
      )
  ) THEN
    RAISE EXCEPTION
      'An incompatible model provider owner has neither a default nor a VM0 peer';
  END IF;
END;
$$;--> statement-breakpoint

UPDATE "model_providers" AS vm0_peer
SET "is_default" = true,
    "selected_model" = 'deepseek-v4-flash',
    "updated_at" = NOW()
FROM (
  SELECT DISTINCT candidate."org_id", candidate."user_id"
  FROM "stage2_incompatible_provider_candidates_0908" AS candidate
) AS owner
WHERE vm0_peer."org_id" = owner."org_id"
  AND vm0_peer."user_id" = owner."user_id"
  AND vm0_peer."type" = 'vm0'
  AND NOT EXISTS (
    SELECT 1
    FROM "model_providers" AS default_provider
    WHERE default_provider."org_id" = owner."org_id"
      AND default_provider."user_id" = owner."user_id"
      AND default_provider."is_default"
  );--> statement-breakpoint

DELETE FROM "model_providers" AS provider
USING "stage2_incompatible_provider_candidates_0908" AS candidate
WHERE provider."id" = candidate."id";--> statement-breakpoint

DELETE FROM "secrets" AS secret
USING "stage2_incompatible_provider_candidates_0908" AS candidate
WHERE secret."id" = candidate."secret_id"
  AND NOT EXISTS (
    SELECT 1
    FROM "model_providers" AS provider
    WHERE provider."secret_id" = secret."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "model_provider_connections" AS connection
    WHERE connection."secret_id" = secret."id"
  );--> statement-breakpoint

DELETE FROM "usage_pricing" AS pricing
WHERE pricing."kind" = 'model'
  AND (
    pg_temp.stage2_aggressive_replacement_0908(
      pricing."provider",
      NULL,
      false
    ) IS NOT NULL
    OR lower(trim(pricing."provider")) IN ('kimi-k2.6', 'kimi-k2.5')
  );--> statement-breakpoint

DO $$
BEGIN
  IF pg_temp.stage2_aggressive_replacement_0908(
    'gpt-5.5',
    NULL,
    false
  ) IS NOT NULL OR pg_temp.stage2_aggressive_replacement_0908(
    'claude-sonnet-4-6',
    NULL,
    false
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'A reopened run model is still classified as aggressive';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_model_policies" AS policy
    LEFT JOIN "org_plan_entitlements" AS entitlement
      ON entitlement."org_id" = policy."org_id"
    WHERE pg_temp.stage2_reopened_model_0908(policy."model") IS NOT NULL
      AND NOT coalesce(entitlement."restricted_vm0_models", false)
      AND NOT EXISTS (
        SELECT 1
        FROM "org_model_policies" AS reopened
        WHERE reopened."org_id" = policy."org_id"
          AND reopened."model" =
            pg_temp.stage2_reopened_model_0908(policy."model")
          AND pg_temp.stage2_policy_route_supports_model_0908(
            reopened."model",
            reopened."org_id",
            reopened."default_provider_type",
            reopened."credential_scope",
            reopened."model_provider_id",
            reopened."model_provider_surface_id"
          )
      )
  ) THEN
    RAISE EXCEPTION 'A reopened model policy is missing or has an invalid route';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_threads" AS thread
    LEFT JOIN "model_providers" AS provider
      ON provider."id" = thread."model_provider_id"
    WHERE (
      pg_temp.stage2_aggressive_replacement_0908(
        thread."selected_model",
        coalesce(thread."model_provider_type", provider."type"),
        false
      ) IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM "stage2_incompatible_provider_candidates_0908" AS candidate
        WHERE candidate."id" = thread."model_provider_id"
      )
    )
  ) THEN
    RAISE EXCEPTION 'An aggressive retired chat thread selection remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "model_providers" AS provider
    WHERE provider."type" IN (
      'minimax-api-key',
      'moonshot-api-key',
      'zai-api-key'
    )
  ) THEN
    RAISE EXCEPTION 'An incompatible direct run-model provider remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "usage_pricing" AS pricing
    WHERE pricing."kind" = 'model'
      AND (
        pg_temp.stage2_aggressive_replacement_0908(
          pricing."provider",
          NULL,
          false
        ) IS NOT NULL
        OR lower(trim(pricing."provider")) IN ('kimi-k2.6', 'kimi-k2.5')
      )
  ) THEN
    RAISE EXCEPTION 'Aggressive retired run-model pricing remains';
  END IF;

  RAISE NOTICE
    'Stage 2 follow-up postconditions: reopened policies restored, eager threads migrated, incompatible providers removed, pricing removed';
END;
$$;
