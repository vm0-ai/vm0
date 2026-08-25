-- Stage 8 final irreversible boundary (#28742, Parent #26938).
-- External deployed-revision gate, accepted by the controller:
-- release 01390c8ae78016cf5cb60f7cf50ee70d5400e4a4 was the only vm0-api
-- revision observed after 2026-08-24T04:29:03Z.
-- Evidence: https://github.com/vm0-ai/vm0/issues/28742#issuecomment-5390865017
--
-- This is intentionally a normal migration. migration-runner.ts owns the
-- enclosing transaction plus lock_timeout=1s and statement_timeout=10s.
-- Broad preservation, reference-partition, and historical acceptance is
-- controller-owned through read-only MaskDB. This transaction keeps only the
-- exact mutation-boundary gates needed to prove that the frozen artifact
-- closure is safe to remove.

DO $$
DECLARE
  manifest_count integer;
  manifest_digest text;
  canonical_fk_count integer;
  canonical_fk_digest text;
  canonical_index_count integer;
  canonical_index_digest text;
  closure_fk_count integer;
  closure_fk_digest text;
BEGIN
  WITH legacy_relations AS (
    SELECT "oid", "reltype"
    FROM "pg_class"
    WHERE "oid" IN (
      'public.agent_composes'::regclass,
      'public.agent_compose_versions'::regclass,
      'public.zero_agents'::regclass
    )
  ),
  manifest AS (
    SELECT
      'depend|' || "dependency"."classid"::regclass::text || '|' ||
      "dependency"."refclassid"::regclass::text || '|' ||
      "dependency"."deptype"::text || '|' ||
      pg_describe_object(
        "dependency"."classid",
        "dependency"."objid",
        "dependency"."objsubid"
      ) || '|' ||
      pg_describe_object(
        "dependency"."refclassid",
        "dependency"."refobjid",
        "dependency"."refobjsubid"
      ) AS "entry"
    FROM "pg_depend" AS "dependency"
    WHERE (
        (
          "dependency"."refclassid" = 'pg_class'::regclass
          AND "dependency"."refobjid" IN (
            SELECT "oid" FROM legacy_relations
          )
        )
        OR (
          "dependency"."refclassid" = 'pg_type'::regclass
          AND "dependency"."refobjid" IN (
            SELECT "reltype" FROM legacy_relations
          )
        )
      )
      AND "dependency"."deptype" <> 'i'
      -- PostgreSQL 18 exposes NOT NULL constraints as pg_constraint rows
      -- with table-internal pg_depend entries; PostgreSQL 17 does not.
      AND NOT (
        "dependency"."classid" = 'pg_constraint'::regclass
        AND "dependency"."refclassid" = 'pg_class'::regclass
        AND EXISTS (
          SELECT 1
          FROM "pg_constraint" AS "not_null_constraint"
          WHERE "not_null_constraint"."oid" = "dependency"."objid"
            AND "not_null_constraint"."contype" = 'n'
            AND "not_null_constraint"."conrelid" =
              "dependency"."refobjid"
        )
      )
    UNION ALL
    SELECT
      'function|' || "namespace"."nspname" || '.' ||
      "function"."proname" || '(' ||
      pg_get_function_identity_arguments("function"."oid") || ')|' ||
      md5("function"."prosrc")
    FROM "pg_proc" AS "function"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "function"."pronamespace"
    WHERE "namespace"."nspname" = 'public'
      AND lower("function"."prosrc") ~
        '(agent_composes|agent_compose_versions|zero_agents)'
    UNION ALL
    SELECT
      'legacy-column|' || "relation"."relname" || '|' ||
      "attribute"."attname" || '|' ||
      format_type("attribute"."atttypid", "attribute"."atttypmod")
    FROM "pg_attribute" AS "attribute"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "attribute"."attrelid"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "attribute"."attnum" > 0
      AND NOT "attribute"."attisdropped"
      AND "attribute"."attname" IN (
        'agent_compose_id',
        'agent_compose_version_id',
        'agent_compose_snapshot',
        'default_compose_id',
        'selected_compose_id'
      )
  )
  SELECT
    count(*)::integer,
    encode(
      sha256(
        convert_to(
          string_agg("entry", E'\n' ORDER BY "entry"),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO manifest_count, manifest_digest
  FROM manifest;

  IF manifest_count <> 86
    OR manifest_digest <>
      'd0d6ebbdcab2e8c1abf6d3997fe14bb9b9e32704ef12f10e017a9dec1e9f19c8'
  THEN
    RAISE EXCEPTION
      'Stage 8 catalog removal manifest drift (count %, digest %)',
      manifest_count,
      manifest_digest;
  END IF;

  WITH entries AS (
    SELECT
      "constraint"."conrelid"::regclass::text || '|' ||
      "constraint"."conname" || '|' ||
      pg_get_constraintdef("constraint"."oid", false) || '|' ||
      "constraint"."convalidated"::text AS "entry"
    FROM "pg_constraint" AS "constraint"
    WHERE "constraint"."contype" = 'f'
      AND "constraint"."confrelid" = 'public.agents'::regclass
  )
  SELECT
    count(*)::integer,
    encode(
      sha256(
        convert_to(
          string_agg("entry", E'\n' ORDER BY "entry"),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO canonical_fk_count, canonical_fk_digest
  FROM entries;

  IF canonical_fk_count <> 18
    OR canonical_fk_digest <>
      'be5b6d820d4d865938b06356864028b207f59840b2f168429b6124f2da4e263f'
  THEN
    RAISE EXCEPTION
      'Stage 8 canonical Agent FK manifest drift (count %, digest %)',
      canonical_fk_count,
      canonical_fk_digest;
  END IF;

  WITH entries AS (
    SELECT
      "index"."tablename" || '|' || "index"."indexname" || '|' ||
      "index"."indexdef" AS "entry"
    FROM "pg_indexes" AS "index"
    WHERE "index"."schemaname" = 'public'
      AND "index"."indexname" IN (
        'agents_pkey',
        'idx_agents_org',
        'idx_agents_org_name',
        'idx_agent_sessions_user_agent',
        'idx_chat_threads_user_agent_updated',
        'idx_chat_threads_user_agent_pinned',
        'idx_chat_threads_user_agent_last_message',
        'chat_event_search_messages_user_org_agent_id_created_idx'
      )
  )
  SELECT
    count(*)::integer,
    encode(
      sha256(
        convert_to(
          string_agg("entry", E'\n' ORDER BY "entry"),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO canonical_index_count, canonical_index_digest
  FROM entries;

  IF canonical_index_count <> 8
    OR canonical_index_digest <>
      '322fe577941ce4d6e5b34de9d115b08e8a304d19238f52df3cef3bf35f9be164'
  THEN
    RAISE EXCEPTION
      'Stage 8 canonical Agent index manifest drift (count %, digest %)',
      canonical_index_count,
      canonical_index_digest;
  END IF;

  WITH entries AS (
    SELECT
      "constraint"."conrelid"::regclass::text || '|' ||
      "constraint"."conname" || '|' ||
      "constraint"."confrelid"::regclass::text || '|' ||
      "constraint"."confdeltype"::text || '|' ||
      "constraint"."convalidated"::text AS "entry"
    FROM "pg_constraint" AS "constraint"
    WHERE "constraint"."contype" = 'f'
      AND "constraint"."confrelid" IN (
        'public.agent_sessions'::regclass,
        'public.agent_runs'::regclass,
        'public.chat_threads'::regclass,
        'public.conversations'::regclass,
        'public.checkpoints'::regclass
      )
  )
  SELECT
    count(*)::integer,
    encode(
      sha256(
        convert_to(
          string_agg("entry", E'\n' ORDER BY "entry"),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO closure_fk_count, closure_fk_digest
  FROM entries;

  IF closure_fk_count <> 51
    OR closure_fk_digest <>
      '24d528dd0bb5776d859a7f4465146227806696e44b0a6a6cb1fba5f168badb65'
  THEN
    RAISE EXCEPTION
      'Stage 8 execution closure FK manifest drift (count %, digest %)',
      closure_fk_count,
      closure_fk_digest;
  END IF;
END
$$;--> statement-breakpoint

CREATE TEMP TABLE "_stage8_approved_artifacts" ON COMMIT DROP AS
SELECT
  "compose"."id",
  "compose"."user_id",
  "compose"."org_id",
  encode(
    sha256(
      convert_to(
        'vm0:agent-compose-consolidation-preflight:v1',
        'UTF8'
      ) ||
      decode('00', 'hex') ||
      convert_to('approved-artifact-member', 'UTF8') ||
      decode('00', 'hex') ||
      convert_to(
        octet_length("compose"."id"::text)::text || ':' ||
        "compose"."id"::text,
        'UTF8'
      ) ||
      decode('00', 'hex')
    ),
    'hex'
  ) AS "member_digest"
FROM "agent_composes" AS "compose"
LEFT JOIN "zero_agents" AS "zero_agent"
  ON "zero_agent"."id" = "compose"."id"
WHERE "zero_agent"."id" IS NULL;--> statement-breakpoint

ALTER TABLE "_stage8_approved_artifacts"
  ADD PRIMARY KEY ("id");--> statement-breakpoint

-- Give the planner the exact six-row cardinality for the bounded temp-table
-- gates below.
ANALYZE "_stage8_approved_artifacts";--> statement-breakpoint

DO $$
DECLARE
  artifact_count integer;
  artifact_member_digests text[];
  artifact_set_digest text;
  relevant_row_exists boolean;
BEGIN
  SELECT
    count(*)::integer,
    coalesce(array_agg("member_digest" ORDER BY "member_digest"), ARRAY[]::text[]),
    encode(
      sha256(
        convert_to(
          'vm0:agent-compose-consolidation-preflight:v1',
          'UTF8'
        ) ||
        decode('00', 'hex') ||
        convert_to('approved-artifact-set', 'UTF8') ||
        decode('00', 'hex') ||
        coalesce(
          string_agg(
            convert_to(
              octet_length("id"::text)::text || ':' || "id"::text,
              'UTF8'
            ) || decode('00', 'hex'),
            decode('', 'hex')
            ORDER BY "id"::text COLLATE "C"
          ),
          decode('', 'hex')
        )
      ),
      'hex'
    )
  INTO artifact_count, artifact_member_digests, artifact_set_digest
  FROM "_stage8_approved_artifacts";

  SELECT EXISTS (
    SELECT 1 FROM "agents"
    UNION ALL SELECT 1 FROM "agent_composes"
    UNION ALL SELECT 1 FROM "zero_agents"
    UNION ALL SELECT 1 FROM "agent_compose_versions"
    UNION ALL SELECT 1 FROM "agent_sessions"
    UNION ALL SELECT 1 FROM "agent_runs"
    UNION ALL SELECT 1 FROM "chat_threads"
    UNION ALL SELECT 1 FROM "chat_thread_events"
    UNION ALL SELECT 1 FROM "chat_event_search_messages"
    UNION ALL SELECT 1 FROM "checkpoints"
  )
  INTO relevant_row_exists;

  IF relevant_row_exists THEN
    IF artifact_count <> 6
      OR artifact_member_digests <> ARRAY[
        '113ad6becc69859c5d32951a5f1a1f0fa4ba80c0d3db8844aa7d03917265220a',
        '8dfd7409ac22987095db85e8d847b68b79ba5dd10061699a2cd8b342f0aa5a53',
        '9697088dede8e0c6d34e043d4e9195cb7f02eed78d03c3b5eaeffaf699a6cdad',
        '96eb4f5d3c590dc9576ebb780be44742b08936936b8230c1b80cb7c52179ae94',
        'da7f6e8f1e287573ecf9e04e7ae2c1f2cb6605f694cfeae4dd748a9ad86ef934',
        'e7bf22154afdeb95446d7be90a79f75813073581a292c334807ea37dd8adc37a'
      ]::text[]
      OR artifact_set_digest <>
        'a83a3c8751fa88778aca7ac93b7d595a7e4c8e9e79cb08c9696ed1dd9e943b5c'
    THEN
      RAISE EXCEPTION
        'Stage 8 approved artifact identity drift (count %, set digest %)',
        artifact_count,
        artifact_set_digest;
    END IF;
  ELSIF artifact_count <> 0 THEN
    RAISE EXCEPTION
      'Stage 8 fresh-schema exception contained artifacts (count %)',
      artifact_count;
  END IF;
END
$$;--> statement-breakpoint

CREATE TEMP TABLE "_stage8_artifact_sessions" ON COMMIT DROP AS
SELECT "session"."id"
FROM "agent_sessions" AS "session"
INNER JOIN "_stage8_approved_artifacts" AS "artifact"
  ON "artifact"."user_id" = "session"."user_id"
  AND "artifact"."id" = "session"."agent_compose_id";--> statement-breakpoint

ALTER TABLE "_stage8_artifact_sessions"
  ADD PRIMARY KEY ("id");--> statement-breakpoint

CREATE TEMP TABLE "_stage8_artifact_runs" ON COMMIT DROP AS
SELECT "run"."id"
FROM "agent_runs" AS "run"
INNER JOIN "_stage8_artifact_sessions" AS "session"
  ON "session"."id" = "run"."session_id";--> statement-breakpoint

ALTER TABLE "_stage8_artifact_runs"
  ADD PRIMARY KEY ("id");--> statement-breakpoint

CREATE TEMP TABLE "_stage8_artifact_threads" ON COMMIT DROP AS
SELECT "thread"."id"
FROM "chat_threads" AS "thread"
INNER JOIN "_stage8_approved_artifacts" AS "artifact"
  ON "artifact"."user_id" = "thread"."user_id"
  AND "artifact"."id" = "thread"."agent_compose_id";--> statement-breakpoint

ALTER TABLE "_stage8_artifact_threads"
  ADD PRIMARY KEY ("id");--> statement-breakpoint

CREATE TEMP TABLE "_stage8_artifact_search_messages" (
  "chat_thread_id" uuid NOT NULL,
  "seq_id" bigint NOT NULL,
  PRIMARY KEY ("chat_thread_id", "seq_id")
) ON COMMIT DROP;--> statement-breakpoint

DO $$
DECLARE
  artifact record;
BEGIN
  FOR artifact IN
    SELECT "id", "user_id", "org_id"
    FROM "_stage8_approved_artifacts"
    ORDER BY "id"
  LOOP
    -- Dynamic execution replans each of the exact six lookups with its
    -- composite index keys instead of admitting a whole-table hash join.
    EXECUTE $stage8_search_lookup$
      INSERT INTO "_stage8_artifact_search_messages" (
        "chat_thread_id", "seq_id"
      )
      SELECT "message"."chat_thread_id", "message"."seq_id"
      FROM "chat_event_search_messages" AS "message"
      WHERE "message"."user_id" = $1
        AND "message"."org_id" = $2
        AND "message"."agent_compose_id" = $3
    $stage8_search_lookup$
    USING artifact.user_id, artifact.org_id, artifact.id;
  END LOOP;
END
$$;--> statement-breakpoint

CREATE TEMP TABLE "_stage8_artifact_versions" ON COMMIT DROP AS
SELECT "version"."id"
FROM "agent_compose_versions" AS "version"
INNER JOIN "_stage8_approved_artifacts" AS "artifact"
  ON "artifact"."id" = "version"."compose_id";--> statement-breakpoint

ALTER TABLE "_stage8_artifact_versions"
  ADD PRIMARY KEY ("id");--> statement-breakpoint

DO $$
DECLARE
  artifact_count integer;
BEGIN
  SELECT count(*)::integer
  INTO artifact_count
  FROM "_stage8_approved_artifacts";

  IF artifact_count = 6 THEN
    IF (SELECT count(*) FROM "_stage8_artifact_versions") <> 7
      OR (SELECT count(*) FROM "_stage8_artifact_sessions") <> 22
      OR (SELECT count(*) FROM "_stage8_artifact_runs") <> 2
      OR (SELECT count(*) FROM "_stage8_artifact_threads") <> 1
      OR (SELECT count(*) FROM "_stage8_artifact_search_messages") <> 2
    THEN
      RAISE EXCEPTION 'Stage 8 approved artifact closure drift';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "agent_runs" AS "run"
      INNER JOIN "_stage8_artifact_runs" AS "artifact_run"
        ON "artifact_run"."id" = "run"."id"
      WHERE "run"."status" <> 'completed'
    ) THEN
      RAISE EXCEPTION 'Stage 8 approved artifact has non-completed Run';
    END IF;
  ELSIF
    (SELECT count(*) FROM "_stage8_artifact_versions") <> 0
    OR (SELECT count(*) FROM "_stage8_artifact_sessions") <> 0
    OR (SELECT count(*) FROM "_stage8_artifact_runs") <> 0
    OR (SELECT count(*) FROM "_stage8_artifact_threads") <> 0
    OR (SELECT count(*) FROM "_stage8_artifact_search_messages") <> 0
  THEN
    RAISE EXCEPTION 'Stage 8 fresh-schema closure is not empty';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "telegram_installations"
    WHERE "default_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
    UNION ALL
    SELECT 1 FROM "feishu_org_installations"
    WHERE "default_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
    UNION ALL
    SELECT 1 FROM "github_installations"
    WHERE "default_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
    UNION ALL
    SELECT 1 FROM "slack_user_agent_preferences"
    WHERE "selected_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
    UNION ALL
    SELECT 1 FROM "teams_user_agent_preferences"
    WHERE "selected_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
    UNION ALL
    SELECT 1 FROM "agentphone_user_agent_preferences"
    WHERE "selected_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
    UNION ALL
    SELECT 1 FROM "telegram_user_agent_preferences"
    WHERE "selected_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
    UNION ALL
    SELECT 1 FROM "feishu_user_agent_preferences"
    WHERE "selected_compose_id" IN (
      SELECT "id" FROM "_stage8_approved_artifacts"
    )
  ) THEN
    RAISE EXCEPTION 'Stage 8 approved artifact has a default/preference/install reference';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "browser_sessions"
    WHERE "run_id" IN (SELECT "id" FROM "_stage8_artifact_runs")
    UNION ALL
    SELECT 1 FROM "built_in_generation_jobs"
    WHERE "run_id" IN (SELECT "id" FROM "_stage8_artifact_runs")
    UNION ALL
    SELECT 1 FROM "morning_brief_deliveries"
    WHERE "run_id" IN (SELECT "id" FROM "_stage8_artifact_runs")
    UNION ALL
    SELECT 1 FROM "morning_brief_schedules"
    WHERE "chat_thread_id" IN (SELECT "id" FROM "_stage8_artifact_threads")
    UNION ALL
    SELECT 1 FROM "run_uploaded_files"
    WHERE "chat_thread_id" IN (SELECT "id" FROM "_stage8_artifact_threads")
      AND "run_id" NOT IN (SELECT "id" FROM "_stage8_artifact_runs")
    UNION ALL
    SELECT 1 FROM "shared_threads"
    WHERE "source_chat_thread_id" IN (
      SELECT "id" FROM "_stage8_artifact_threads"
    )
    UNION ALL
    SELECT 1 FROM "workflow_user_automation_threads"
    WHERE "chat_thread_id" IN (SELECT "id" FROM "_stage8_artifact_threads")
  ) THEN
    RAISE EXCEPTION 'Stage 8 approved artifact has an unexpected protected carrier';
  END IF;
END
$$;--> statement-breakpoint

DO $$
DECLARE
  artifact_count integer;
  artifact_member_digests text[];
  artifact_set_digest text;
  relevant_row_exists boolean;
BEGIN
  SELECT
    count(*)::integer,
    coalesce(array_agg("member_digest" ORDER BY "member_digest"), ARRAY[]::text[]),
    encode(
      sha256(
        convert_to(
          'vm0:agent-compose-consolidation-preflight:v1',
          'UTF8'
        ) ||
        decode('00', 'hex') ||
        convert_to('approved-artifact-set', 'UTF8') ||
        decode('00', 'hex') ||
        coalesce(
          string_agg(
            convert_to(
              octet_length("id"::text)::text || ':' || "id"::text,
              'UTF8'
            ) || decode('00', 'hex'),
            decode('', 'hex')
            ORDER BY "id"::text COLLATE "C"
          ),
          decode('', 'hex')
        )
      ),
      'hex'
    )
  INTO artifact_count, artifact_member_digests, artifact_set_digest
  FROM "_stage8_approved_artifacts";

  SELECT EXISTS (
    SELECT 1 FROM "agents"
    UNION ALL SELECT 1 FROM "agent_composes"
    UNION ALL SELECT 1 FROM "zero_agents"
    UNION ALL SELECT 1 FROM "agent_compose_versions"
    UNION ALL SELECT 1 FROM "agent_sessions"
    UNION ALL SELECT 1 FROM "agent_runs"
    UNION ALL SELECT 1 FROM "chat_threads"
    UNION ALL SELECT 1 FROM "chat_thread_events"
    UNION ALL SELECT 1 FROM "chat_event_search_messages"
    UNION ALL SELECT 1 FROM "checkpoints"
  )
  INTO relevant_row_exists;

  IF relevant_row_exists THEN
    IF artifact_count <> 6
      OR artifact_member_digests <> ARRAY[
        '113ad6becc69859c5d32951a5f1a1f0fa4ba80c0d3db8844aa7d03917265220a',
        '8dfd7409ac22987095db85e8d847b68b79ba5dd10061699a2cd8b342f0aa5a53',
        '9697088dede8e0c6d34e043d4e9195cb7f02eed78d03c3b5eaeffaf699a6cdad',
        '96eb4f5d3c590dc9576ebb780be44742b08936936b8230c1b80cb7c52179ae94',
        'da7f6e8f1e287573ecf9e04e7ae2c1f2cb6605f694cfeae4dd748a9ad86ef934',
        'e7bf22154afdeb95446d7be90a79f75813073581a292c334807ea37dd8adc37a'
      ]::text[]
      OR artifact_set_digest <>
        'a83a3c8751fa88778aca7ac93b7d595a7e4c8e9e79cb08c9696ed1dd9e943b5c'
    THEN
      RAISE EXCEPTION
        'Stage 8 approved artifact identity drift (count %, set digest %)',
        artifact_count,
        artifact_set_digest;
    END IF;
  ELSIF artifact_count <> 0 THEN
    RAISE EXCEPTION
      'Stage 8 fresh-schema exception contained artifacts (count %)',
      artifact_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "zero_agents" AS "zero_agent"
    LEFT JOIN "agent_composes" AS "compose"
      ON "compose"."id" = "zero_agent"."id"
    WHERE "compose"."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Stage 8 zero-only identity drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "zero_agents" AS "zero_agent"
    INNER JOIN "agent_composes" AS "compose"
      ON "compose"."id" = "zero_agent"."id"
    LEFT JOIN "agents" AS "agent"
      ON "agent"."id" = "zero_agent"."id"
    WHERE "agent"."id" IS NULL
      OR ROW(
        "compose"."org_id",
        "compose"."user_id",
        "compose"."name"
      ) IS DISTINCT FROM ROW(
        "zero_agent"."org_id",
        "zero_agent"."owner",
        "zero_agent"."name"
      )
      OR ROW(
        "agent"."org_id",
        "agent"."owner",
        "agent"."name"
      ) IS DISTINCT FROM ROW(
        "compose"."org_id",
        "compose"."user_id",
        "compose"."name"
      )
  ) THEN
    RAISE EXCEPTION 'Stage 8 canonical immutable Agent identity drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_stage8_approved_artifacts" AS "artifact"
    INNER JOIN "agents" AS "agent" ON "agent"."id" = "artifact"."id"
  ) THEN
    RAISE EXCEPTION 'Stage 8 approved artifact unexpectedly resolves in agents';
  END IF;
END
$$;--> statement-breakpoint

CREATE TEMP TABLE "_stage8_artifact_billing" ON COMMIT DROP AS
SELECT
  'usage_event'::text AS "cohort",
  "row"."id",
  (to_jsonb("row") - 'run_id')::text AS "payload"
FROM "usage_event" AS "row"
WHERE "row"."run_id" IN (SELECT "id" FROM "_stage8_artifact_runs")
UNION ALL
SELECT
  'usage_event_hourly_rollup',
  "row"."id",
  (to_jsonb("row") - 'run_id')::text
FROM "usage_event_hourly_rollup" AS "row"
WHERE "row"."run_id" IN (SELECT "id" FROM "_stage8_artifact_runs")
UNION ALL
SELECT
  'usage_allowance_allocations',
  "row"."id",
  (to_jsonb("row") - 'run_id')::text
FROM "usage_allowance_allocations" AS "row"
WHERE "row"."run_id" IN (SELECT "id" FROM "_stage8_artifact_runs")
UNION ALL
SELECT
  'org_usage_allowance_windows',
  "row"."id",
  (to_jsonb("row") - 'created_by_run_id')::text
FROM "org_usage_allowance_windows" AS "row"
WHERE "row"."created_by_run_id" IN (
  SELECT "id" FROM "_stage8_artifact_runs"
);--> statement-breakpoint

ALTER TABLE "_stage8_artifact_billing"
  ADD PRIMARY KEY ("cohort", "id");--> statement-breakpoint

DROP TRIGGER "agent_compose_versions_delete_veto"
  ON "agent_compose_versions";--> statement-breakpoint
DROP TRIGGER "agent_compose_versions_write_provenance"
  ON "agent_compose_versions";--> statement-breakpoint
DROP TRIGGER "agent_composes_delete_lock_timeout_transition"
  ON "agent_composes";--> statement-breakpoint
DROP TRIGGER "bridge_agent_composes_to_agents_0966"
  ON "agent_composes";--> statement-breakpoint
DROP TRIGGER "bridge_agent_sessions_agent_reference_0966"
  ON "agent_sessions";--> statement-breakpoint
DROP TRIGGER "bridge_agentphone_preferences_agent_reference_0966"
  ON "agentphone_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "bridge_chat_event_search_agent_reference_0966"
  ON "chat_event_search_messages";--> statement-breakpoint
DROP TRIGGER "bridge_chat_thread_events_agent_reference_0966"
  ON "chat_thread_events";--> statement-breakpoint
DROP TRIGGER "bridge_chat_threads_agent_reference_0966"
  ON "chat_threads";--> statement-breakpoint
DROP TRIGGER "bridge_feishu_installations_agent_reference_0966"
  ON "feishu_org_installations";--> statement-breakpoint
DROP TRIGGER "bridge_feishu_preferences_agent_reference_0966"
  ON "feishu_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "bridge_github_installations_agent_reference_0966"
  ON "github_installations";--> statement-breakpoint
DROP TRIGGER "bridge_slack_preferences_agent_reference_0966"
  ON "slack_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "bridge_teams_preferences_agent_reference_0966"
  ON "teams_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "bridge_telegram_installations_agent_reference_0966"
  ON "telegram_installations";--> statement-breakpoint
DROP TRIGGER "bridge_telegram_preferences_agent_reference_0966"
  ON "telegram_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "users_clerk_cleanup_transition_guard"
  ON "users";--> statement-breakpoint
DROP TRIGGER "bridge_zero_agent_default_avatar_0927"
  ON "zero_agents";--> statement-breakpoint
DROP TRIGGER "bridge_zero_agents_to_agents_0966"
  ON "zero_agents";--> statement-breakpoint

DROP FUNCTION "veto_agent_compose_version_delete_transition"();--> statement-breakpoint
DROP FUNCTION "enforce_agent_compose_version_write_transition"();--> statement-breakpoint
DROP FUNCTION "set_agent_compose_delete_lock_timeout_transition"();--> statement-breakpoint
DROP FUNCTION "bridge_agent_compose_reference_0966"();--> statement-breakpoint
DROP FUNCTION "bridge_default_compose_reference_0966"();--> statement-breakpoint
DROP FUNCTION "bridge_selected_compose_reference_0966"();--> statement-breakpoint
DROP FUNCTION "guard_clerk_user_cleanup_transition"();--> statement-breakpoint
DROP FUNCTION "bridge_zero_agent_default_avatar_0927"();--> statement-breakpoint
DROP FUNCTION "bridge_legacy_agent_to_agents_0966"();--> statement-breakpoint
DROP FUNCTION "sync_agent_from_legacy_0966"(uuid);--> statement-breakpoint

DO $$
DECLARE
  deleted_count integer;
  expected_count integer;
BEGIN
  SELECT count(*)::integer
  INTO expected_count
  FROM "_stage8_approved_artifacts";

  DELETE FROM "agent_composes"
  WHERE "id" IN (SELECT "id" FROM "_stage8_approved_artifacts");
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  IF deleted_count <> expected_count THEN
    RAISE EXCEPTION
      'Stage 8 approved artifact delete count drift (expected %, deleted %)',
      expected_count,
      deleted_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_stage8_artifact_sessions" AS "frozen"
    INNER JOIN "agent_sessions" AS "live" ON "live"."id" = "frozen"."id"
  ) OR EXISTS (
    SELECT 1
    FROM "_stage8_artifact_runs" AS "frozen"
    INNER JOIN "agent_runs" AS "live" ON "live"."id" = "frozen"."id"
  ) OR EXISTS (
    SELECT 1
    FROM "_stage8_artifact_threads" AS "frozen"
    INNER JOIN "chat_threads" AS "live" ON "live"."id" = "frozen"."id"
  ) OR EXISTS (
    SELECT 1
    FROM "_stage8_artifact_search_messages" AS "frozen"
    INNER JOIN "chat_event_search_messages" AS "live"
      ON "live"."chat_thread_id" = "frozen"."chat_thread_id"
      AND "live"."seq_id" = "frozen"."seq_id"
  ) THEN
    RAISE EXCEPTION 'Stage 8 approved non-billing closure was not deleted';
  END IF;
END
$$;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    WITH current_billing AS (
      SELECT
        'usage_event'::text AS "cohort",
        "row"."id",
        "row"."run_id",
        (to_jsonb("row") - 'run_id')::text AS "payload"
      FROM "usage_event" AS "row"
      WHERE "row"."id" IN (
        SELECT "id"
        FROM "_stage8_artifact_billing"
        WHERE "cohort" = 'usage_event'
      )
      UNION ALL
      SELECT
        'usage_event_hourly_rollup',
        "row"."id",
        "row"."run_id",
        (to_jsonb("row") - 'run_id')::text
      FROM "usage_event_hourly_rollup" AS "row"
      WHERE "row"."id" IN (
        SELECT "id"
        FROM "_stage8_artifact_billing"
        WHERE "cohort" = 'usage_event_hourly_rollup'
      )
      UNION ALL
      SELECT
        'usage_allowance_allocations',
        "row"."id",
        "row"."run_id",
        (to_jsonb("row") - 'run_id')::text
      FROM "usage_allowance_allocations" AS "row"
      WHERE "row"."id" IN (
        SELECT "id"
        FROM "_stage8_artifact_billing"
        WHERE "cohort" = 'usage_allowance_allocations'
      )
      UNION ALL
      SELECT
        'org_usage_allowance_windows',
        "row"."id",
        "row"."created_by_run_id",
        (to_jsonb("row") - 'created_by_run_id')::text
      FROM "org_usage_allowance_windows" AS "row"
      WHERE "row"."id" IN (
        SELECT "id"
        FROM "_stage8_artifact_billing"
        WHERE "cohort" = 'org_usage_allowance_windows'
      )
    )
    SELECT 1
    FROM "_stage8_artifact_billing" AS "frozen"
    LEFT JOIN current_billing AS "current"
      ON "current"."cohort" = "frozen"."cohort"
      AND "current"."id" = "frozen"."id"
    WHERE "current"."id" IS NULL
      OR "current"."run_id" IS NOT NULL
      OR "current"."payload" IS DISTINCT FROM "frozen"."payload"
  ) THEN
    RAISE EXCEPTION 'Stage 8 billing/usage retention drift';
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "agent_sessions"
  DROP CONSTRAINT "agent_sessions_agent_reference_match";--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences"
  DROP CONSTRAINT "agentphone_user_agent_preferences_agent_reference_match";--> statement-breakpoint
ALTER TABLE "chat_event_search_messages"
  DROP CONSTRAINT "chat_event_search_messages_agent_reference_match";--> statement-breakpoint
ALTER TABLE "chat_thread_events"
  DROP CONSTRAINT "chat_thread_events_agent_reference_match";--> statement-breakpoint
ALTER TABLE "chat_threads"
  DROP CONSTRAINT "chat_threads_agent_reference_match";--> statement-breakpoint
ALTER TABLE "feishu_org_installations"
  DROP CONSTRAINT "feishu_org_installations_agent_reference_match";--> statement-breakpoint
ALTER TABLE "github_installations"
  DROP CONSTRAINT "github_installations_agent_reference_match";--> statement-breakpoint
ALTER TABLE "telegram_installations"
  DROP CONSTRAINT "telegram_installations_agent_reference_match";--> statement-breakpoint

ALTER TABLE "agent_runs"
  DROP CONSTRAINT "agent_runs_agent_compose_version_id_agent_compose_versions_id_fk";--> statement-breakpoint
ALTER TABLE "agent_sessions"
  DROP CONSTRAINT "agent_sessions_agent_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences"
  DROP CONSTRAINT "agentphone_user_agent_preferences_selected_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "chat_threads"
  DROP CONSTRAINT "chat_threads_agent_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "feishu_org_installations"
  DROP CONSTRAINT "feishu_org_installations_default_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences"
  DROP CONSTRAINT "feishu_user_agent_preferences_selected_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "github_installations"
  DROP CONSTRAINT "github_installations_default_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences"
  DROP CONSTRAINT "slack_user_agent_preferences_selected_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences"
  DROP CONSTRAINT "teams_user_agent_preferences_selected_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "telegram_installations"
  DROP CONSTRAINT "telegram_installations_default_compose_id_agent_composes_id_fk";--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences"
  DROP CONSTRAINT "telegram_user_agent_preferences_selected_compose_id_agent_composes_id_fk";--> statement-breakpoint

DROP INDEX "idx_agent_sessions_user_compose";--> statement-breakpoint
DROP INDEX "chat_event_search_messages_user_org_agent_created_idx";--> statement-breakpoint
DROP INDEX "idx_chat_threads_user_compose_updated";--> statement-breakpoint
DROP INDEX "idx_chat_threads_user_compose_pinned";--> statement-breakpoint
DROP INDEX "idx_chat_threads_user_compose_last_message";--> statement-breakpoint

ALTER TABLE "agent_runs"
  DROP COLUMN "agent_compose_version_id";--> statement-breakpoint
ALTER TABLE "agent_sessions"
  DROP COLUMN "agent_compose_id";--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences"
  DROP COLUMN "selected_compose_id";--> statement-breakpoint
ALTER TABLE "chat_event_search_messages"
  DROP COLUMN "agent_compose_id";--> statement-breakpoint
ALTER TABLE "chat_thread_events"
  DROP COLUMN "agent_compose_id";--> statement-breakpoint
ALTER TABLE "chat_threads"
  DROP COLUMN "agent_compose_id";--> statement-breakpoint
ALTER TABLE "checkpoints"
  DROP COLUMN "agent_compose_snapshot";--> statement-breakpoint
ALTER TABLE "feishu_org_installations"
  DROP COLUMN "default_compose_id";--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences"
  DROP COLUMN "selected_compose_id";--> statement-breakpoint
ALTER TABLE "github_installations"
  DROP COLUMN "default_compose_id";--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences"
  DROP COLUMN "selected_compose_id";--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences"
  DROP COLUMN "selected_compose_id";--> statement-breakpoint
ALTER TABLE "telegram_installations"
  DROP COLUMN "default_compose_id";--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences"
  DROP COLUMN "selected_compose_id";--> statement-breakpoint

DROP TABLE "zero_agents";--> statement-breakpoint
DROP TABLE "agent_compose_versions";--> statement-breakpoint
DROP TABLE "agent_composes";--> statement-breakpoint

DO $$
DECLARE
  canonical_fk_count integer;
  canonical_fk_digest text;
  canonical_index_count integer;
  canonical_index_digest text;
BEGIN
  IF to_regclass('public.agent_composes') IS NOT NULL
    OR to_regclass('public.agent_compose_versions') IS NOT NULL
    OR to_regclass('public.zero_agents') IS NOT NULL
  THEN
    RAISE EXCEPTION 'Stage 8 legacy relation survived contraction';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_attribute" AS "attribute"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "attribute"."attrelid"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "attribute"."attnum" > 0
      AND NOT "attribute"."attisdropped"
      AND "attribute"."attname" IN (
        'agent_compose_id',
        'agent_compose_version_id',
        'agent_compose_snapshot',
        'default_compose_id',
        'selected_compose_id'
      )
  ) OR EXISTS (
    SELECT 1
    FROM "pg_proc" AS "function"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "function"."pronamespace"
    WHERE "namespace"."nspname" = 'public'
      AND (
        "function"."proname" ~
          '(agent_compose|default_compose|selected_compose|zero_agent)'
        OR lower("function"."prosrc") ~
          '(agent_composes|agent_compose_versions|zero_agents)'
      )
  ) OR EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" ~
      '(agent_compose|default_compose|selected_compose|zero_agents)'
  ) OR EXISTS (
    SELECT 1
    FROM "pg_class"
    WHERE "relkind" IN ('i', 'I')
      AND "relname" ~
        '(agent_compose|default_compose|selected_compose|zero_agents)'
  ) OR EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE NOT "tgisinternal"
      AND "tgname" ~
        '(agent_compose|default_compose|selected_compose|zero_agent)'
  ) THEN
    RAISE EXCEPTION 'Stage 8 legacy catalog object survived contraction';
  END IF;

  WITH entries AS (
    SELECT
      "constraint"."conrelid"::regclass::text || '|' ||
      "constraint"."conname" || '|' ||
      pg_get_constraintdef("constraint"."oid", false) || '|' ||
      "constraint"."convalidated"::text AS "entry"
    FROM "pg_constraint" AS "constraint"
    WHERE "constraint"."contype" = 'f'
      AND "constraint"."confrelid" = 'public.agents'::regclass
  )
  SELECT
    count(*)::integer,
    encode(
      sha256(
        convert_to(
          string_agg("entry", E'\n' ORDER BY "entry"),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO canonical_fk_count, canonical_fk_digest
  FROM entries;

  IF canonical_fk_count <> 18
    OR canonical_fk_digest <>
      'be5b6d820d4d865938b06356864028b207f59840b2f168429b6124f2da4e263f'
  THEN
    RAISE EXCEPTION 'Stage 8 canonical Agent FK postflight drift';
  END IF;

  WITH entries AS (
    SELECT
      "index"."tablename" || '|' || "index"."indexname" || '|' ||
      "index"."indexdef" AS "entry"
    FROM "pg_indexes" AS "index"
    WHERE "index"."schemaname" = 'public'
      AND "index"."indexname" IN (
        'agents_pkey',
        'idx_agents_org',
        'idx_agents_org_name',
        'idx_agent_sessions_user_agent',
        'idx_chat_threads_user_agent_updated',
        'idx_chat_threads_user_agent_pinned',
        'idx_chat_threads_user_agent_last_message',
        'chat_event_search_messages_user_org_agent_id_created_idx'
      )
  )
  SELECT
    count(*)::integer,
    encode(
      sha256(
        convert_to(
          string_agg("entry", E'\n' ORDER BY "entry"),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO canonical_index_count, canonical_index_digest
  FROM entries;

  IF canonical_index_count <> 8
    OR canonical_index_digest <>
      '322fe577941ce4d6e5b34de9d115b08e8a304d19238f52df3cef3bf35f9be164'
  THEN
    RAISE EXCEPTION 'Stage 8 canonical Agent index postflight drift';
  END IF;
END
$$;
