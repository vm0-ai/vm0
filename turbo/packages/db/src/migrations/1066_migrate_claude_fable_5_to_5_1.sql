-- Custom SQL migration file; preserved after migration renumbering.
-- Operationally replace Claude Fable 5 with Claude Fable 5.1 while keeping
-- the predecessor available during the compatibility window. Current
-- configuration is migrated; immutable run history, usage history, prior
-- thread events, snapshots, and queued run payloads are intentionally left
-- unchanged.

CREATE OR REPLACE FUNCTION pg_temp.fable_5_source_model_1062(
  raw_model text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(trim(raw_model)) IN (
    'claude-fable-5',
    'anthropic/claude-fable-5'
  )
$$;--> statement-breakpoint

-- Keep this status mapping aligned with runtimeStatusForEntitlement(). A
-- suspended organization cannot run any model, so migrating its stored Fable
-- preference to 5.1 does not expand access and preserves intent if it resumes.
CREATE OR REPLACE FUNCTION pg_temp.fable_5_plan_is_active_1062(
  entitlement_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT entitlement_status IN (
    'active',
    'trialing',
    'past_due',
    'unpaid',
    'atom_grant',
    'manual_active'
  )
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.fable_5_successor_route_valid_1062(
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
        AND surface."protocol" = 'anthropic-messages'
        AND provider_type = 'custom-anthropic-messages'
        AND jsonb_typeof(
          surface."model_mappings" -> 'claude-fable-5-1'
        ) = 'string'
        AND nullif(
          btrim(surface."model_mappings" ->> 'claude-fable-5-1'),
          ''
        ) IS NOT NULL
    );
  END IF;

  IF credential_scope = 'member' THEN
    RETURN provider_type = 'claude-code-oauth-token'
      AND model_provider_id IS NULL;
  END IF;

  IF credential_scope <> 'org' THEN
    RETURN false;
  END IF;

  IF provider_type = 'built-in' THEN
    RETURN model_provider_id IS NULL;
  END IF;

  IF provider_type NOT IN (
    'anthropic-api-key',
    'openrouter-api-key',
    'vercel-ai-gateway'
  ) OR model_provider_id IS NULL THEN
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

-- Model policy writes are rare, and serializing them prevents an administrator
-- update from racing the successor insert or default transfer.
LOCK TABLE "org_model_policies" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

CREATE TEMP TABLE "fable_5_migration_orgs_1062"
ON COMMIT DROP
AS
WITH candidate_orgs AS (
  SELECT policy."org_id"
  FROM "org_model_policies" AS policy
  WHERE policy."model" = 'claude-fable-5'

  UNION

  SELECT member."org_id"
  FROM "org_members_metadata" AS member
  WHERE pg_temp.fable_5_source_model_1062(member."selected_model")

  UNION

  SELECT agent."org_id"
  FROM "agents" AS agent
  WHERE pg_temp.fable_5_source_model_1062(agent."selected_model")

  UNION

  SELECT provider."org_id"
  FROM "model_providers" AS provider
  WHERE pg_temp.fable_5_source_model_1062(provider."selected_model")

  UNION

  SELECT agent."org_id"
  FROM "chat_threads" AS thread
  INNER JOIN "agents" AS agent
    ON agent."id" = thread."agent_id"
  WHERE pg_temp.fable_5_source_model_1062(thread."selected_model")
)
SELECT
  candidate."org_id",
  CASE
    WHEN pg_temp.fable_5_plan_is_active_1062(entitlement."status")
      AND entitlement."restricted_built_in_models"
    THEN 'fallback'
    ELSE 'replace'
  END AS "action",
  entitlement."status" AS "entitlement_status",
  entitlement."support_byok"
FROM candidate_orgs AS candidate
INNER JOIN "org_plan_entitlements" AS entitlement
  ON entitlement."org_id" = candidate."org_id";--> statement-breakpoint

ALTER TABLE "fable_5_migration_orgs_1062"
  ADD PRIMARY KEY ("org_id");--> statement-breakpoint

DO $$
DECLARE
  replace_org_count bigint;
  fallback_org_count bigint;
  orphan_policy_count bigint;
  member_count bigint;
  thread_count bigint;
  agent_count bigint;
  provider_count bigint;
  active_run_count bigint;
  queued_run_count bigint;
BEGIN
  SELECT count(*) FILTER (WHERE "action" = 'replace'),
         count(*) FILTER (WHERE "action" = 'fallback')
  INTO replace_org_count, fallback_org_count
  FROM "fable_5_migration_orgs_1062";

  SELECT count(*) INTO orphan_policy_count
  FROM "org_model_policies" AS policy
  WHERE policy."model" = 'claude-fable-5'
    AND NOT EXISTS (
      SELECT 1
      FROM "fable_5_migration_orgs_1062" AS migration_org
      WHERE migration_org."org_id" = policy."org_id"
    );

  SELECT count(*) INTO member_count
  FROM "org_members_metadata" AS member
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = member."org_id"
  WHERE pg_temp.fable_5_source_model_1062(member."selected_model");

  SELECT count(*) INTO thread_count
  FROM "chat_threads" AS thread
  INNER JOIN "agents" AS agent
    ON agent."id" = thread."agent_id"
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = agent."org_id"
  WHERE pg_temp.fable_5_source_model_1062(thread."selected_model");

  SELECT count(*) INTO agent_count
  FROM "agents" AS agent
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = agent."org_id"
  WHERE pg_temp.fable_5_source_model_1062(agent."selected_model");

  SELECT count(*) INTO provider_count
  FROM "model_providers" AS provider
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = provider."org_id"
  WHERE pg_temp.fable_5_source_model_1062(provider."selected_model");

  SELECT count(*) INTO active_run_count
  FROM "agent_runs" AS run
  WHERE pg_temp.fable_5_source_model_1062(run."selected_model")
    AND run."status" IN ('pending', 'queued', 'running');

  SELECT count(*) INTO queued_run_count
  FROM "agent_run_queue" AS queue
  INNER JOIN "agent_runs" AS run
    ON run."id" = queue."run_id"
  WHERE pg_temp.fable_5_source_model_1062(run."selected_model");

  RAISE NOTICE
    'Fable 5 migration candidates: replace_orgs=%, fallback_orgs=%, orphan_policies=%, members=%, threads=%, agents=%, providers=%, active_runs_unchanged=%, queued_runs_unchanged=%',
    replace_org_count,
    fallback_org_count,
    orphan_policy_count,
    member_count,
    thread_count,
    agent_count,
    provider_count,
    active_run_count,
    queued_run_count;
END;
$$;--> statement-breakpoint

-- Add the successor policy only when the predecessor's route is structurally
-- valid for Fable 5.1. Existing successor policies win so administrator route
-- choices are never overwritten.
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
  predecessor."org_id",
  'claude-fable-5-1',
  false,
  predecessor."default_provider_type",
  predecessor."credential_scope",
  predecessor."model_provider_id",
  predecessor."model_provider_surface_id",
  predecessor."created_by_user_id",
  predecessor."updated_by_user_id",
  now(),
  now()
FROM "org_model_policies" AS predecessor
INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
  ON migration_org."org_id" = predecessor."org_id"
  AND migration_org."action" = 'replace'
WHERE predecessor."model" = 'claude-fable-5'
  AND pg_temp.fable_5_successor_route_valid_1062(
    predecessor."org_id",
    predecessor."default_provider_type",
    predecessor."credential_scope",
    predecessor."model_provider_id",
    predecessor."model_provider_surface_id"
  )
ON CONFLICT ("org_id", "model") DO NOTHING;--> statement-breakpoint

-- Every replacement organization must have a valid successor route before any
-- preference or thread is pointed at it. This also catches a conflicting,
-- already-present but unusable Fable 5.1 policy.
DO $$
DECLARE
  invalid_successor_count bigint;
BEGIN
  SELECT count(*) INTO invalid_successor_count
  FROM "fable_5_migration_orgs_1062" AS migration_org
  WHERE migration_org."action" = 'replace'
    AND NOT EXISTS (
      SELECT 1
      FROM "org_model_policies" AS successor
      WHERE successor."org_id" = migration_org."org_id"
        AND successor."model" = 'claude-fable-5-1'
        AND pg_temp.fable_5_successor_route_valid_1062(
          successor."org_id",
          successor."default_provider_type",
          successor."credential_scope",
          successor."model_provider_id",
          successor."model_provider_surface_id"
        )
    );

  IF invalid_successor_count <> 0 THEN
    RAISE EXCEPTION
      'Fable 5 migration requires valid successor policies for every replacement organization; missing or invalid=%',
      invalid_successor_count;
  END IF;
END;
$$;--> statement-breakpoint

-- Active restricted organizations cannot use either Fable version. Only add a
-- built-in DeepSeek fallback when current Fable state actually needs changing.
CREATE TEMP TABLE "fable_5_fallback_orgs_1062"
ON COMMIT DROP
AS
SELECT migration_org."org_id"
FROM "fable_5_migration_orgs_1062" AS migration_org
WHERE migration_org."action" = 'fallback'
  AND (
    EXISTS (
      SELECT 1
      FROM "org_model_policies" AS policy
      WHERE policy."org_id" = migration_org."org_id"
        AND policy."model" = 'claude-fable-5'
        AND policy."is_default"
    )
    OR EXISTS (
      SELECT 1
      FROM "org_members_metadata" AS member
      WHERE member."org_id" = migration_org."org_id"
        AND pg_temp.fable_5_source_model_1062(member."selected_model")
    )
    OR EXISTS (
      SELECT 1
      FROM "agents" AS agent
      WHERE agent."org_id" = migration_org."org_id"
        AND pg_temp.fable_5_source_model_1062(agent."selected_model")
    )
    OR EXISTS (
      SELECT 1
      FROM "model_providers" AS provider
      WHERE provider."org_id" = migration_org."org_id"
        AND pg_temp.fable_5_source_model_1062(provider."selected_model")
    )
    OR EXISTS (
      SELECT 1
      FROM "chat_threads" AS thread
      INNER JOIN "agents" AS agent
        ON agent."id" = thread."agent_id"
      WHERE agent."org_id" = migration_org."org_id"
        AND pg_temp.fable_5_source_model_1062(thread."selected_model")
    )
  );--> statement-breakpoint

ALTER TABLE "fable_5_fallback_orgs_1062"
  ADD PRIMARY KEY ("org_id");--> statement-breakpoint

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
  fallback_org."org_id",
  'deepseek-v4-flash',
  false,
  'built-in',
  'org',
  NULL,
  NULL,
  predecessor."created_by_user_id",
  predecessor."updated_by_user_id",
  now(),
  now()
FROM "fable_5_fallback_orgs_1062" AS fallback_org
LEFT JOIN "org_model_policies" AS predecessor
  ON predecessor."org_id" = fallback_org."org_id"
  AND predecessor."model" = 'claude-fable-5'
ON CONFLICT ("org_id", "model") DO NOTHING;--> statement-breakpoint

UPDATE "org_model_policies" AS fallback
SET "default_provider_type" = 'built-in',
    "credential_scope" = 'org',
    "model_provider_id" = NULL,
    "model_provider_surface_id" = NULL,
    "updated_at" = now()
FROM "fable_5_fallback_orgs_1062" AS fallback_org
WHERE fallback."org_id" = fallback_org."org_id"
  AND fallback."model" = 'deepseek-v4-flash'
  AND (
    fallback."default_provider_type" <> 'built-in'
    OR fallback."credential_scope" <> 'org'
    OR fallback."model_provider_id" IS NOT NULL
    OR fallback."model_provider_surface_id" IS NOT NULL
  );--> statement-breakpoint

CREATE TEMP TABLE "fable_5_default_updates_1062"
ON COMMIT DROP
AS
SELECT
  predecessor."org_id",
  CASE migration_org."action"
    WHEN 'fallback' THEN 'deepseek-v4-flash'
    ELSE 'claude-fable-5-1'
  END AS "target_model"
FROM "org_model_policies" AS predecessor
INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
  ON migration_org."org_id" = predecessor."org_id"
WHERE predecessor."model" = 'claude-fable-5'
  AND predecessor."is_default";--> statement-breakpoint

ALTER TABLE "fable_5_default_updates_1062"
  ADD PRIMARY KEY ("org_id");--> statement-breakpoint

UPDATE "org_model_policies" AS predecessor
SET "is_default" = false,
    "updated_at" = now()
FROM "fable_5_default_updates_1062" AS candidate
WHERE predecessor."org_id" = candidate."org_id"
  AND predecessor."model" = 'claude-fable-5'
  AND predecessor."is_default";--> statement-breakpoint

UPDATE "org_model_policies" AS target
SET "is_default" = true,
    "updated_at" = now()
FROM "fable_5_default_updates_1062" AS candidate
WHERE target."org_id" = candidate."org_id"
  AND target."model" = candidate."target_model";--> statement-breakpoint

UPDATE "org_members_metadata" AS member
SET "selected_model" = CASE migration_org."action"
      WHEN 'fallback' THEN 'deepseek-v4-flash'
      ELSE 'claude-fable-5-1'
    END,
    "service_tier" = NULL,
    "updated_at" = now()
FROM "fable_5_migration_orgs_1062" AS migration_org
WHERE member."org_id" = migration_org."org_id"
  AND pg_temp.fable_5_source_model_1062(member."selected_model");--> statement-breakpoint

CREATE TEMP TABLE "fable_5_thread_updates_1062"
ON COMMIT DROP
AS
SELECT
  thread."id",
  thread."user_id",
  thread."agent_id",
  agent."org_id",
  CASE migration_org."action"
    WHEN 'fallback' THEN 'deepseek-v4-flash'
    ELSE 'claude-fable-5-1'
  END AS "target_model",
  thread."codex_service_tier" IS NOT NULL AS "had_service_tier"
FROM "chat_threads" AS thread
INNER JOIN "agents" AS agent
  ON agent."id" = thread."agent_id"
INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
  ON migration_org."org_id" = agent."org_id"
WHERE pg_temp.fable_5_source_model_1062(thread."selected_model");--> statement-breakpoint

ALTER TABLE "fable_5_thread_updates_1062"
  ADD PRIMARY KEY ("id");--> statement-breakpoint

CREATE TEMP TABLE "fable_5_migrated_threads_1062"
ON COMMIT DROP
AS
WITH migrated AS (
  UPDATE "chat_threads" AS thread
  SET "selected_model" = candidate."target_model",
      "model_provider_id" = NULL,
      "model_provider_type" = NULL,
      "model_provider_credential_scope" = NULL,
      "codex_service_tier" = NULL,
      "updated_at" = now()
  FROM "fable_5_thread_updates_1062" AS candidate
  WHERE thread."id" = candidate."id"
    AND pg_temp.fable_5_source_model_1062(thread."selected_model")
  RETURNING
    thread."id",
    thread."user_id",
    thread."agent_id",
    candidate."org_id",
    candidate."target_model",
    candidate."had_service_tier",
    thread."updated_at" AS "migrated_at"
)
SELECT * FROM migrated;--> statement-breakpoint

CREATE TEMP TABLE "fable_5_model_events_1062"
ON COMMIT DROP
AS
WITH inserted AS (
  INSERT INTO "chat_thread_events" (
    "id",
    "user_id",
    "org_id",
    "chat_thread_id",
    "kind",
    "agent_id",
    "selected_model",
    "created_at"
  )
  SELECT
    gen_random_uuid(),
    migrated."user_id",
    migrated."org_id",
    migrated."id",
    'model_selection_updated',
    migrated."agent_id",
    migrated."target_model",
    migrated."migrated_at"
  FROM "fable_5_migrated_threads_1062" AS migrated
  RETURNING "chat_thread_id"
)
SELECT * FROM inserted;--> statement-breakpoint

CREATE TEMP TABLE "fable_5_tier_events_1062"
ON COMMIT DROP
AS
WITH inserted AS (
  INSERT INTO "chat_thread_events" (
    "id",
    "user_id",
    "org_id",
    "chat_thread_id",
    "kind",
    "agent_id",
    "service_tier",
    "created_at"
  )
  SELECT
    gen_random_uuid(),
    migrated."user_id",
    migrated."org_id",
    migrated."id",
    'service_tier_updated',
    migrated."agent_id",
    NULL,
    migrated."migrated_at"
  FROM "fable_5_migrated_threads_1062" AS migrated
  WHERE migrated."had_service_tier"
  RETURNING "chat_thread_id"
)
SELECT * FROM inserted;--> statement-breakpoint

-- Agent defaults are legacy route pins. Preserve compatible provider syntax
-- for replacement organizations; restricted active organizations inherit the
-- built-in DeepSeek fallback instead.
UPDATE "agents" AS agent
SET "selected_model" = 'deepseek-v4-flash',
    "model_provider_id" = NULL,
    "updated_at" = now()
FROM "fable_5_migration_orgs_1062" AS migration_org
WHERE agent."org_id" = migration_org."org_id"
  AND migration_org."action" = 'fallback'
  AND pg_temp.fable_5_source_model_1062(agent."selected_model");--> statement-breakpoint

UPDATE "agents" AS agent
SET "selected_model" = 'claude-fable-5-1',
    "updated_at" = now()
FROM "fable_5_migration_orgs_1062" AS migration_org
WHERE agent."org_id" = migration_org."org_id"
  AND migration_org."action" = 'replace'
  AND agent."model_provider_id" IS NULL
  AND pg_temp.fable_5_source_model_1062(agent."selected_model");--> statement-breakpoint

UPDATE "agents" AS agent
SET "selected_model" = CASE
      WHEN provider."type" IN (
        'openrouter-api-key',
        'vercel-ai-gateway'
      ) THEN 'anthropic/claude-fable-5.1'
      ELSE 'claude-fable-5-1'
    END,
    "updated_at" = now()
FROM "fable_5_migration_orgs_1062" AS migration_org,
     "model_providers" AS provider
WHERE agent."org_id" = migration_org."org_id"
  AND migration_org."action" = 'replace'
  AND provider."id" = agent."model_provider_id"
  AND provider."org_id" = agent."org_id"
  AND provider."type" IN (
    'built-in',
    'claude-code-oauth-token',
    'anthropic-api-key',
    'openrouter-api-key',
    'vercel-ai-gateway'
  )
  AND pg_temp.fable_5_source_model_1062(agent."selected_model");--> statement-breakpoint

UPDATE "model_providers" AS provider
SET "selected_model" = CASE
      WHEN migration_org."action" = 'fallback' THEN NULL
      WHEN provider."type" IN (
        'openrouter-api-key',
        'vercel-ai-gateway'
      ) THEN 'anthropic/claude-fable-5.1'
      ELSE 'claude-fable-5-1'
    END,
    "updated_at" = now()
FROM "fable_5_migration_orgs_1062" AS migration_org
WHERE provider."org_id" = migration_org."org_id"
  AND provider."type" IN (
    'built-in',
    'claude-code-oauth-token',
    'anthropic-api-key',
    'openrouter-api-key',
    'vercel-ai-gateway'
  )
  AND pg_temp.fable_5_source_model_1062(provider."selected_model");--> statement-breakpoint

DO $$
DECLARE
  invalid_successor_count bigint;
  invalid_default_count bigint;
  residual_member_count bigint;
  residual_thread_count bigint;
  residual_agent_count bigint;
  residual_provider_count bigint;
  migrated_thread_count bigint;
  model_event_count bigint;
  tier_thread_count bigint;
  tier_event_count bigint;
BEGIN
  SELECT count(*) INTO invalid_successor_count
  FROM "fable_5_migration_orgs_1062" AS migration_org
  WHERE migration_org."action" = 'replace'
    AND NOT EXISTS (
      SELECT 1
      FROM "org_model_policies" AS successor
      WHERE successor."org_id" = migration_org."org_id"
        AND successor."model" = 'claude-fable-5-1'
        AND pg_temp.fable_5_successor_route_valid_1062(
          successor."org_id",
          successor."default_provider_type",
          successor."credential_scope",
          successor."model_provider_id",
          successor."model_provider_surface_id"
        )
    );

  SELECT count(*) INTO invalid_default_count
  FROM "fable_5_default_updates_1062" AS candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM "org_model_policies" AS target
    WHERE target."org_id" = candidate."org_id"
      AND target."model" = candidate."target_model"
      AND target."is_default"
  ) OR EXISTS (
    SELECT 1
    FROM "org_model_policies" AS predecessor
    WHERE predecessor."org_id" = candidate."org_id"
      AND predecessor."model" = 'claude-fable-5'
      AND predecessor."is_default"
  );

  SELECT count(*) INTO residual_member_count
  FROM "org_members_metadata" AS member
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = member."org_id"
  WHERE pg_temp.fable_5_source_model_1062(member."selected_model");

  SELECT count(*) INTO residual_thread_count
  FROM "chat_threads" AS thread
  INNER JOIN "agents" AS agent
    ON agent."id" = thread."agent_id"
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = agent."org_id"
  WHERE pg_temp.fable_5_source_model_1062(thread."selected_model");

  SELECT count(*) INTO residual_agent_count
  FROM "agents" AS agent
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = agent."org_id"
  LEFT JOIN "model_providers" AS provider
    ON provider."id" = agent."model_provider_id"
    AND provider."org_id" = agent."org_id"
  WHERE pg_temp.fable_5_source_model_1062(agent."selected_model")
    AND (
      migration_org."action" = 'fallback'
      OR agent."model_provider_id" IS NULL
      OR provider."type" IN (
        'built-in',
        'claude-code-oauth-token',
        'anthropic-api-key',
        'openrouter-api-key',
        'vercel-ai-gateway'
      )
    );

  SELECT count(*) INTO residual_provider_count
  FROM "model_providers" AS provider
  INNER JOIN "fable_5_migration_orgs_1062" AS migration_org
    ON migration_org."org_id" = provider."org_id"
  WHERE pg_temp.fable_5_source_model_1062(provider."selected_model")
    AND provider."type" IN (
      'built-in',
      'claude-code-oauth-token',
      'anthropic-api-key',
      'openrouter-api-key',
      'vercel-ai-gateway'
    );

  SELECT count(*) INTO migrated_thread_count
  FROM "fable_5_migrated_threads_1062";
  SELECT count(*) INTO model_event_count
  FROM "fable_5_model_events_1062";
  SELECT count(*) INTO tier_thread_count
  FROM "fable_5_migrated_threads_1062"
  WHERE "had_service_tier";
  SELECT count(*) INTO tier_event_count
  FROM "fable_5_tier_events_1062";

  IF invalid_successor_count <> 0
    OR invalid_default_count <> 0
    OR residual_member_count <> 0
    OR residual_thread_count <> 0
    OR residual_agent_count <> 0
    OR residual_provider_count <> 0
    OR migrated_thread_count <> model_event_count
    OR tier_thread_count <> tier_event_count
  THEN
    RAISE EXCEPTION
      'Fable 5 migration postcondition failed: invalid_successors=%, invalid_defaults=%, residual_members=%, residual_threads=%, residual_agents=%, residual_providers=%, migrated_threads=%, model_events=%, tier_threads=%, tier_events=%',
      invalid_successor_count,
      invalid_default_count,
      residual_member_count,
      residual_thread_count,
      residual_agent_count,
      residual_provider_count,
      migrated_thread_count,
      model_event_count,
      tier_thread_count,
      tier_event_count;
  END IF;

  RAISE NOTICE
    'Fable 5 migration complete: defaults=%, threads=%, model_events=%, tier_events=%',
    (SELECT count(*) FROM "fable_5_default_updates_1062"),
    migrated_thread_count,
    model_event_count,
    tier_event_count;
END;
$$;
