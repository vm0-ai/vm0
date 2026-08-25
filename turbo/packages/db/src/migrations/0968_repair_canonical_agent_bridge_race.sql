-- vm0:non-transactional
-- #28653 / #26938 closes the absent-target race in the temporary Stage 5
-- legacy-to-agents bridge. Legacy relations remain application-authoritative.

BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sync_agent_from_legacy_0966"(
  p_agent_id uuid
) RETURNS void AS $$
BEGIN
  -- Serialize before reading either source, including while no target row
  -- exists. The transaction-scoped lock is released on commit or rollback.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('canonical-agent:' || p_agent_id::text, 0)
  );

  -- Delete only when a legacy identity row disappears. Retaining the last
  -- complete target through an in-transaction two-row update avoids a
  -- transient mismatch cascading dependent-row deletion.
  DELETE FROM "agents" AS "agent"
  WHERE "agent"."id" = p_agent_id
    AND (
      NOT EXISTS (
        SELECT 1 FROM "agent_composes" AS "compose"
        WHERE "compose"."id" = p_agent_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM "zero_agents" AS "zero_agent"
        WHERE "zero_agent"."id" = p_agent_id
      )
    );

  INSERT INTO "agents" (
    "id", "org_id", "owner", "name", "visibility", "display_name",
    "description", "sound", "avatar_url", "model_provider_id",
    "selected_model", "prefer_personal_provider", "created_at", "updated_at"
  )
  SELECT
    "compose"."id",
    "zero_agent"."org_id",
    "zero_agent"."owner",
    "zero_agent"."name",
    "zero_agent"."visibility",
    "zero_agent"."display_name",
    "zero_agent"."description",
    "zero_agent"."sound",
    "zero_agent"."avatar_url",
    "zero_agent"."model_provider_id",
    "zero_agent"."selected_model",
    "zero_agent"."prefer_personal_provider",
    "compose"."created_at",
    greatest("compose"."updated_at", "zero_agent"."updated_at")
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "compose"."id" = p_agent_id
    AND "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
    AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
    AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name"
  ON CONFLICT ("id") DO UPDATE SET
    "org_id" = excluded."org_id",
    "owner" = excluded."owner",
    "name" = excluded."name",
    "visibility" = excluded."visibility",
    "display_name" = excluded."display_name",
    "description" = excluded."description",
    "sound" = excluded."sound",
    "avatar_url" = excluded."avatar_url",
    "model_provider_id" = excluded."model_provider_id",
    "selected_model" = excluded."selected_model",
    "prefer_personal_provider" = excluded."prefer_personal_provider",
    "created_at" = excluded."created_at",
    "updated_at" = excluded."updated_at";
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Repair only matched canonical rows through the corrected sync function.
-- Source-row ownership prevents mixed pairs while advisory serialization
-- coordinates this repair with the permanent bridge.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "repair_canonical_agents_0968"(
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after uuid := NULL;
  v_batch_ids uuid[];
  v_batch_count integer;
  v_batch_mismatch_count integer;
  v_agent_id uuid;
  v_remaining boolean;
  v_initial_repair_count bigint;
  v_repaired_count bigint := 0;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
  v_compose_only_count_before bigint;
  v_compose_only_count_after bigint;
  v_compose_only_null_before bigint;
  v_compose_only_null_after bigint;
  v_deleted_snapshot_anchor_null_before bigint;
  v_deleted_snapshot_anchor_null_after bigint;
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Canonical Agent repair no-progress timeout must be between 0 and 30 seconds';
  END IF;

  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  SELECT count(*)
  INTO v_initial_repair_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
    AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
    AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name"
    AND (
      "agent"."id" IS NULL
      OR ROW(
        "agent"."org_id", "agent"."owner", "agent"."name",
        "agent"."visibility", "agent"."display_name",
        "agent"."description", "agent"."sound", "agent"."avatar_url",
        "agent"."model_provider_id", "agent"."selected_model",
        "agent"."prefer_personal_provider", "agent"."created_at",
        "agent"."updated_at"
      ) IS DISTINCT FROM ROW(
        "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
        "zero_agent"."visibility", "zero_agent"."display_name",
        "zero_agent"."description", "zero_agent"."sound",
        "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
        "zero_agent"."selected_model",
        "zero_agent"."prefer_personal_provider", "compose"."created_at",
        greatest("compose"."updated_at", "zero_agent"."updated_at")
      )
    );

  SELECT count(*)
  INTO v_compose_only_count_before
  FROM "agent_composes" AS "compose"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_compose_only_null_before
  FROM (
    SELECT "agent_compose_id" AS "legacy_id", "agent_id" AS "target_id"
    FROM "agent_sessions"
    UNION ALL
    SELECT "agent_compose_id", "agent_id" FROM "chat_threads"
    UNION ALL
    SELECT "agent_compose_id", "agent_id" FROM "chat_thread_events"
    UNION ALL
    SELECT "agent_compose_id", "agent_id"
    FROM "chat_event_search_messages"
  ) AS "reference"
  INNER JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "reference"."legacy_id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "reference"."legacy_id"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "reference"."legacy_id"
  WHERE "reference"."legacy_id" IS NOT NULL
    AND "reference"."target_id" IS NULL
    AND "zero_agent"."id" IS NULL
    AND "agent"."id" IS NULL;

  SELECT count(*)
  INTO v_deleted_snapshot_anchor_null_before
  FROM "chat_thread_events" AS "source"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "source"."agent_compose_id"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "source"."agent_compose_id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "source"."agent_compose_id"
  WHERE "source"."agent_compose_id" IS NOT NULL
    AND "source"."agent_id" IS NULL
    AND "agent"."id" IS NULL
    AND "compose"."id" IS NULL
    AND "zero_agent"."id" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "chat_threads" AS "live_thread"
      WHERE "live_thread"."id" = "source"."chat_thread_id"
    )
    AND EXISTS (
      SELECT 1
      FROM "chat_thread_snapshots" AS "snapshot"
      WHERE "snapshot"."user_id" = "source"."user_id"
        AND "snapshot"."org_id" = "source"."org_id"
        AND "snapshot"."latest_event_id" = "source"."id"
    );

  LOOP
    WITH "batch" AS MATERIALIZED (
      SELECT "compose"."id"
      FROM "agent_composes" AS "compose"
      INNER JOIN "zero_agents" AS "zero_agent"
        ON "zero_agent"."id" = "compose"."id"
      LEFT JOIN "agents" AS "agent"
        ON "agent"."id" = "compose"."id"
      WHERE (v_scan_after IS NULL OR "compose"."id" > v_scan_after)
        AND "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
        AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
        AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name"
        AND (
          "agent"."id" IS NULL
          OR ROW(
            "agent"."org_id", "agent"."owner", "agent"."name",
            "agent"."visibility", "agent"."display_name",
            "agent"."description", "agent"."sound", "agent"."avatar_url",
            "agent"."model_provider_id", "agent"."selected_model",
            "agent"."prefer_personal_provider", "agent"."created_at",
            "agent"."updated_at"
          ) IS DISTINCT FROM ROW(
            "zero_agent"."org_id", "zero_agent"."owner",
            "zero_agent"."name", "zero_agent"."visibility",
            "zero_agent"."display_name", "zero_agent"."description",
            "zero_agent"."sound", "zero_agent"."avatar_url",
            "zero_agent"."model_provider_id", "zero_agent"."selected_model",
            "zero_agent"."prefer_personal_provider", "compose"."created_at",
            greatest("compose"."updated_at", "zero_agent"."updated_at")
          )
        )
      ORDER BY "compose"."id"
      LIMIT 500
      FOR UPDATE OF "compose", "zero_agent" SKIP LOCKED
    )
    SELECT coalesce(
      array_agg("batch"."id" ORDER BY "batch"."id"),
      ARRAY[]::uuid[]
    )
    INTO v_batch_ids
    FROM "batch";

    v_batch_count := cardinality(v_batch_ids);

    FOREACH v_agent_id IN ARRAY v_batch_ids
    LOOP
      PERFORM "sync_agent_from_legacy_0966"(v_agent_id);
    END LOOP;

    IF v_batch_count > 0 THEN
      SELECT count(*)
      INTO v_batch_mismatch_count
      FROM unnest(v_batch_ids) AS "batch"("id")
      LEFT JOIN "agent_composes" AS "compose"
        ON "compose"."id" = "batch"."id"
      LEFT JOIN "zero_agents" AS "zero_agent"
        ON "zero_agent"."id" = "batch"."id"
      LEFT JOIN "agents" AS "agent"
        ON "agent"."id" = "batch"."id"
      WHERE "compose"."id" IS NULL
        OR "zero_agent"."id" IS NULL
        OR "agent"."id" IS NULL
        OR "compose"."org_id" IS DISTINCT FROM "zero_agent"."org_id"
        OR "compose"."user_id" IS DISTINCT FROM "zero_agent"."owner"
        OR "compose"."name" IS DISTINCT FROM "zero_agent"."name"
        OR ROW(
          "agent"."org_id", "agent"."owner", "agent"."name",
          "agent"."visibility", "agent"."display_name",
          "agent"."description", "agent"."sound", "agent"."avatar_url",
          "agent"."model_provider_id", "agent"."selected_model",
          "agent"."prefer_personal_provider", "agent"."created_at",
          "agent"."updated_at"
        ) IS DISTINCT FROM ROW(
          "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
          "zero_agent"."visibility", "zero_agent"."display_name",
          "zero_agent"."description", "zero_agent"."sound",
          "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
          "zero_agent"."selected_model",
          "zero_agent"."prefer_personal_provider", "compose"."created_at",
          greatest("compose"."updated_at", "zero_agent"."updated_at")
        );

      IF v_batch_mismatch_count <> 0 THEN
        RAISE EXCEPTION 'Canonical Agent repair left % mismatches in its current batch',
          v_batch_mismatch_count;
      END IF;

      v_scan_after := v_batch_ids[v_batch_count];
      v_repaired_count := v_repaired_count + v_batch_count;
      v_no_progress_started_at := clock_timestamp();
    END IF;

    COMMIT;
    SET LOCAL lock_timeout = '1s';
    SET LOCAL transaction_timeout = '5min';

    IF v_batch_count > 0 THEN
      PERFORM pg_sleep(0.01);
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "agent_composes" AS "compose"
      INNER JOIN "zero_agents" AS "zero_agent"
        ON "zero_agent"."id" = "compose"."id"
      LEFT JOIN "agents" AS "agent"
        ON "agent"."id" = "compose"."id"
      WHERE "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
        AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
        AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name"
        AND (
          "agent"."id" IS NULL
          OR ROW(
            "agent"."org_id", "agent"."owner", "agent"."name",
            "agent"."visibility", "agent"."display_name",
            "agent"."description", "agent"."sound", "agent"."avatar_url",
            "agent"."model_provider_id", "agent"."selected_model",
            "agent"."prefer_personal_provider", "agent"."created_at",
            "agent"."updated_at"
          ) IS DISTINCT FROM ROW(
            "zero_agent"."org_id", "zero_agent"."owner",
            "zero_agent"."name", "zero_agent"."visibility",
            "zero_agent"."display_name", "zero_agent"."description",
            "zero_agent"."sound", "zero_agent"."avatar_url",
            "zero_agent"."model_provider_id", "zero_agent"."selected_model",
            "zero_agent"."prefer_personal_provider", "compose"."created_at",
            greatest("compose"."updated_at", "zero_agent"."updated_at")
          )
        )
    ) INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
      RAISE EXCEPTION 'Canonical Agent repair made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after := NULL;
    PERFORM pg_sleep(0.01);
  END LOOP;

  SELECT count(*)
  INTO v_compose_only_count_after
  FROM "agent_composes" AS "compose"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_compose_only_null_after
  FROM (
    SELECT "agent_compose_id" AS "legacy_id", "agent_id" AS "target_id"
    FROM "agent_sessions"
    UNION ALL
    SELECT "agent_compose_id", "agent_id" FROM "chat_threads"
    UNION ALL
    SELECT "agent_compose_id", "agent_id" FROM "chat_thread_events"
    UNION ALL
    SELECT "agent_compose_id", "agent_id"
    FROM "chat_event_search_messages"
  ) AS "reference"
  INNER JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "reference"."legacy_id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "reference"."legacy_id"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "reference"."legacy_id"
  WHERE "reference"."legacy_id" IS NOT NULL
    AND "reference"."target_id" IS NULL
    AND "zero_agent"."id" IS NULL
    AND "agent"."id" IS NULL;

  SELECT count(*)
  INTO v_deleted_snapshot_anchor_null_after
  FROM "chat_thread_events" AS "source"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "source"."agent_compose_id"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "source"."agent_compose_id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "source"."agent_compose_id"
  WHERE "source"."agent_compose_id" IS NOT NULL
    AND "source"."agent_id" IS NULL
    AND "agent"."id" IS NULL
    AND "compose"."id" IS NULL
    AND "zero_agent"."id" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "chat_threads" AS "live_thread"
      WHERE "live_thread"."id" = "source"."chat_thread_id"
    )
    AND EXISTS (
      SELECT 1
      FROM "chat_thread_snapshots" AS "snapshot"
      WHERE "snapshot"."user_id" = "source"."user_id"
        AND "snapshot"."org_id" = "source"."org_id"
        AND "snapshot"."latest_event_id" = "source"."id"
    );

  IF
    v_compose_only_count_after <> v_compose_only_count_before
    OR v_compose_only_null_after <> v_compose_only_null_before
    OR v_deleted_snapshot_anchor_null_after <>
      v_deleted_snapshot_anchor_null_before
  THEN
    RAISE EXCEPTION 'Canonical Agent repair changed protected closure counts: compose_only % -> %, compose_only_null % -> %, deleted_snapshot_anchor_null % -> %',
      v_compose_only_count_before,
      v_compose_only_count_after,
      v_compose_only_null_before,
      v_compose_only_null_after,
      v_deleted_snapshot_anchor_null_before,
      v_deleted_snapshot_anchor_null_after;
  END IF;

  RAISE NOTICE 'Canonical Agent repair: initial_mismatch=%, repaired=%, compose_only=%, compose_only_null_references=%, deleted_snapshot_anchor_null_references=%',
    v_initial_repair_count,
    v_repaired_count,
    v_compose_only_count_after,
    v_compose_only_null_after,
    v_deleted_snapshot_anchor_null_after;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
CALL "repair_canonical_agents_0968"(interval '30 seconds');
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "repair_canonical_agents_0968"(interval);
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Aggregate-only parity and catalog closure. Protected cohort values are
-- reported only as counts; raw Agent ids and product values never leave SQL.
BEGIN;
--> statement-breakpoint
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
DO $$
DECLARE
  v_matched_count bigint;
  v_target_count bigint;
  v_missing_target_count bigint;
  v_target_only_count bigint;
  v_compose_only_target_count bigint;
  v_identity_mismatch_count bigint;
  v_field_mismatch_count bigint;
  v_compose_only_count bigint;
  v_compose_only_null_count bigint;
  v_deleted_snapshot_anchor_null_count bigint;
  v_reference_valid_missing bigint;
  v_reference_mismatch bigint;
  v_reference_target_only bigint;
  v_reference_unclassified_null bigint;
  v_reference_compose_only_null bigint;
  v_reference_deleted_snapshot_anchor_null bigint;
  v_existing_final_missing bigint;
  v_bridge_trigger_count integer;
  v_bridge_object_count integer;
  v_target_trigger_count integer;
  v_validated_fk_count integer;
  v_validated_check_count integer;
  v_valid_index_count integer;
  v_temporary_procedure_count integer;
  v_sync_definition text;
BEGIN
  SELECT count(*)
  INTO v_matched_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id";

  SELECT count(*) INTO v_target_count FROM "agents";

  SELECT count(*)
  INTO v_missing_target_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE "agent"."id" IS NULL;

  SELECT count(*)
  INTO v_target_only_count
  FROM "agents" AS "agent"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "agent"."id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "agent"."id"
  WHERE "compose"."id" IS NULL OR "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_compose_only_target_count
  FROM "agents" AS "agent"
  INNER JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "agent"."id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "agent"."id"
  WHERE "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_identity_mismatch_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "compose"."org_id" IS DISTINCT FROM "zero_agent"."org_id"
    OR "compose"."user_id" IS DISTINCT FROM "zero_agent"."owner"
    OR "compose"."name" IS DISTINCT FROM "zero_agent"."name";

  SELECT count(*)
  INTO v_field_mismatch_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  INNER JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE ROW(
    "agent"."org_id", "agent"."owner", "agent"."name",
    "agent"."visibility", "agent"."display_name", "agent"."description",
    "agent"."sound", "agent"."avatar_url", "agent"."model_provider_id",
    "agent"."selected_model", "agent"."prefer_personal_provider",
    "agent"."created_at", "agent"."updated_at"
  ) IS DISTINCT FROM ROW(
    "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
    "zero_agent"."visibility", "zero_agent"."display_name",
    "zero_agent"."description", "zero_agent"."sound",
    "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
    "zero_agent"."selected_model", "zero_agent"."prefer_personal_provider",
    "compose"."created_at",
    greatest("compose"."updated_at", "zero_agent"."updated_at")
  );

  IF
    v_target_count <> v_matched_count
    OR v_missing_target_count <> 0
    OR v_target_only_count <> 0
    OR v_compose_only_target_count <> 0
    OR v_identity_mismatch_count <> 0
    OR v_field_mismatch_count <> 0
  THEN
    RAISE EXCEPTION 'Canonical Agent repair parity failed: matched %, target %, missing %, target_only %, compose_only_target %, identity_mismatch %, field_mismatch %',
      v_matched_count,
      v_target_count,
      v_missing_target_count,
      v_target_only_count,
      v_compose_only_target_count,
      v_identity_mismatch_count,
      v_field_mismatch_count;
  END IF;

  SELECT count(*)
  INTO v_compose_only_count
  FROM "agent_composes" AS "compose"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_compose_only_null_count
  FROM (
    SELECT "agent_compose_id" AS "legacy_id", "agent_id" AS "target_id"
    FROM "agent_sessions"
    UNION ALL
    SELECT "agent_compose_id", "agent_id" FROM "chat_threads"
    UNION ALL
    SELECT "agent_compose_id", "agent_id" FROM "chat_thread_events"
    UNION ALL
    SELECT "agent_compose_id", "agent_id"
    FROM "chat_event_search_messages"
  ) AS "reference"
  INNER JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "reference"."legacy_id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "reference"."legacy_id"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "reference"."legacy_id"
  WHERE "reference"."legacy_id" IS NOT NULL
    AND "reference"."target_id" IS NULL
    AND "zero_agent"."id" IS NULL
    AND "agent"."id" IS NULL;

  SELECT count(*)
  INTO v_deleted_snapshot_anchor_null_count
  FROM "chat_thread_events" AS "source"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "source"."agent_compose_id"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "source"."agent_compose_id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "source"."agent_compose_id"
  WHERE "source"."agent_compose_id" IS NOT NULL
    AND "source"."agent_id" IS NULL
    AND "agent"."id" IS NULL
    AND "compose"."id" IS NULL
    AND "zero_agent"."id" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "chat_threads" AS "live_thread"
      WHERE "live_thread"."id" = "source"."chat_thread_id"
    )
    AND EXISTS (
      SELECT 1
      FROM "chat_thread_snapshots" AS "snapshot"
      WHERE "snapshot"."user_id" = "source"."user_id"
        AND "snapshot"."org_id" = "source"."org_id"
        AND "snapshot"."latest_event_id" = "source"."id"
    );

  WITH "reference"(
    "source_table", "legacy_id", "target_id", "event_id", "thread_id",
    "user_id", "org_id"
  ) AS (
    SELECT
      'agent_sessions'::text, "agent_compose_id", "agent_id",
      NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "agent_sessions"
    UNION ALL
    SELECT
      'chat_threads', "agent_compose_id", "agent_id",
      NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "chat_threads"
    UNION ALL
    SELECT
      'chat_thread_events', "agent_compose_id", "agent_id",
      "id", "chat_thread_id", "user_id", "org_id"
    FROM "chat_thread_events"
    UNION ALL
    SELECT
      'chat_event_search_messages', "agent_compose_id", "agent_id",
      NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "chat_event_search_messages"
    UNION ALL
    SELECT
      'telegram_installations', "default_compose_id", "default_agent_id",
      NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "telegram_installations"
    UNION ALL
    SELECT
      'feishu_org_installations', "default_compose_id", "default_agent_id",
      NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "feishu_org_installations"
    UNION ALL
    SELECT
      'github_installations', "default_compose_id", "default_agent_id",
      NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "github_installations"
    UNION ALL
    SELECT
      'slack_user_agent_preferences', "selected_compose_id",
      "selected_agent_id", NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "slack_user_agent_preferences"
    UNION ALL
    SELECT
      'teams_user_agent_preferences', "selected_compose_id",
      "selected_agent_id", NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "teams_user_agent_preferences"
    UNION ALL
    SELECT
      'agentphone_user_agent_preferences', "selected_compose_id",
      "selected_agent_id", NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "agentphone_user_agent_preferences"
    UNION ALL
    SELECT
      'telegram_user_agent_preferences', "selected_compose_id",
      "selected_agent_id", NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "telegram_user_agent_preferences"
    UNION ALL
    SELECT
      'feishu_user_agent_preferences', "selected_compose_id",
      "selected_agent_id", NULL::uuid, NULL::uuid, NULL::text, NULL::text
    FROM "feishu_user_agent_preferences"
  )
  SELECT
    count(*) FILTER (
      WHERE "reference"."legacy_id" IS NOT NULL
        AND "reference"."target_id" IS NULL
        AND "agent"."id" IS NOT NULL
    ),
    count(*) FILTER (
      WHERE "reference"."target_id" IS NOT NULL
        AND "reference"."target_id" IS DISTINCT FROM
          "reference"."legacy_id"
    ),
    count(*) FILTER (
      WHERE "reference"."target_id" IS NOT NULL
        AND "reference"."legacy_id" IS NULL
    ),
    count(*) FILTER (
      WHERE "reference"."legacy_id" IS NOT NULL
        AND "reference"."target_id" IS NULL
        AND "agent"."id" IS NULL
        AND NOT (
          "reference"."source_table" = ANY(ARRAY[
            'agent_sessions',
            'chat_threads',
            'chat_thread_events',
            'chat_event_search_messages'
          ]::text[])
          AND "compose"."id" IS NOT NULL
          AND "zero_agent"."id" IS NULL
        )
        AND NOT (
          "reference"."source_table" = 'chat_thread_events'
          AND "compose"."id" IS NULL
          AND "zero_agent"."id" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "chat_threads" AS "live_thread"
            WHERE "live_thread"."id" = "reference"."thread_id"
          )
          AND EXISTS (
            SELECT 1
            FROM "chat_thread_snapshots" AS "snapshot"
            WHERE "snapshot"."user_id" = "reference"."user_id"
              AND "snapshot"."org_id" = "reference"."org_id"
              AND "snapshot"."latest_event_id" = "reference"."event_id"
          )
        )
    ),
    count(*) FILTER (
      WHERE "reference"."legacy_id" IS NOT NULL
        AND "reference"."target_id" IS NULL
        AND "agent"."id" IS NULL
        AND "reference"."source_table" = ANY(ARRAY[
          'agent_sessions',
          'chat_threads',
          'chat_thread_events',
          'chat_event_search_messages'
        ]::text[])
        AND "compose"."id" IS NOT NULL
        AND "zero_agent"."id" IS NULL
    ),
    count(*) FILTER (
      WHERE "reference"."legacy_id" IS NOT NULL
        AND "reference"."target_id" IS NULL
        AND "agent"."id" IS NULL
        AND "reference"."source_table" = 'chat_thread_events'
        AND "compose"."id" IS NULL
        AND "zero_agent"."id" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "chat_threads" AS "live_thread"
          WHERE "live_thread"."id" = "reference"."thread_id"
        )
        AND EXISTS (
          SELECT 1
          FROM "chat_thread_snapshots" AS "snapshot"
          WHERE "snapshot"."user_id" = "reference"."user_id"
            AND "snapshot"."org_id" = "reference"."org_id"
            AND "snapshot"."latest_event_id" = "reference"."event_id"
        )
    )
  INTO
    v_reference_valid_missing,
    v_reference_mismatch,
    v_reference_target_only,
    v_reference_unclassified_null,
    v_reference_compose_only_null,
    v_reference_deleted_snapshot_anchor_null
  FROM "reference"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "reference"."legacy_id"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "reference"."legacy_id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "reference"."legacy_id";

  SELECT count(*)
  INTO v_existing_final_missing
  FROM (
    SELECT "default_agent_id" AS "agent_id" FROM "org_metadata"
    UNION ALL
    SELECT "agent_id" FROM "zero_workflows"
    UNION ALL
    SELECT "agent_id" FROM "user_connectors"
    UNION ALL
    SELECT "agent_id" FROM "user_custom_connectors"
    UNION ALL
    SELECT "agent_id" FROM "user_permission_grants"
    UNION ALL
    SELECT "agent_id" FROM "zero_agent_drafts"
    UNION ALL
    SELECT "agent_id" FROM "banking_agent_enablements"
    UNION ALL
    SELECT "agent_id" FROM "thread_goals"
  ) AS "reference"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "reference"."agent_id"
  WHERE "reference"."agent_id" IS NOT NULL
    AND "agent"."id" IS NULL;

  IF
    v_reference_valid_missing <> 0
    OR v_reference_mismatch <> 0
    OR v_reference_target_only <> 0
    OR v_reference_unclassified_null <> 0
    OR v_reference_compose_only_null <> v_compose_only_null_count
    OR v_reference_deleted_snapshot_anchor_null <>
      v_deleted_snapshot_anchor_null_count
    OR v_existing_final_missing <> 0
  THEN
    RAISE EXCEPTION 'Canonical Agent repair reference parity failed: valid_missing %, mismatch %, target_only %, unclassified_null %, compose_only_null %, deleted_snapshot_anchor_null %, existing_final_missing %',
      v_reference_valid_missing,
      v_reference_mismatch,
      v_reference_target_only,
      v_reference_unclassified_null,
      v_reference_compose_only_null,
      v_reference_deleted_snapshot_anchor_null,
      v_existing_final_missing;
  END IF;

  SELECT count(*)
  INTO v_bridge_trigger_count
  FROM "pg_trigger" AS "trigger"
  INNER JOIN "pg_proc" AS "function"
    ON "function"."oid" = "trigger"."tgfoid"
  WHERE NOT "trigger"."tgisinternal"
    AND "trigger"."tgenabled" = 'O'
    AND ("trigger"."tgrelid", "trigger"."tgname", "function"."proname") IN (
      ('public.agent_composes'::regclass, 'bridge_agent_composes_to_agents_0966', 'bridge_legacy_agent_to_agents_0966'),
      ('public.zero_agents'::regclass, 'bridge_zero_agents_to_agents_0966', 'bridge_legacy_agent_to_agents_0966'),
      ('public.agent_sessions'::regclass, 'bridge_agent_sessions_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.chat_threads'::regclass, 'bridge_chat_threads_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.chat_thread_events'::regclass, 'bridge_chat_thread_events_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.chat_event_search_messages'::regclass, 'bridge_chat_event_search_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.telegram_installations'::regclass, 'bridge_telegram_installations_agent_reference_0966', 'bridge_default_compose_reference_0966'),
      ('public.feishu_org_installations'::regclass, 'bridge_feishu_installations_agent_reference_0966', 'bridge_default_compose_reference_0966'),
      ('public.github_installations'::regclass, 'bridge_github_installations_agent_reference_0966', 'bridge_default_compose_reference_0966'),
      ('public.slack_user_agent_preferences'::regclass, 'bridge_slack_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.teams_user_agent_preferences'::regclass, 'bridge_teams_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.agentphone_user_agent_preferences'::regclass, 'bridge_agentphone_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.telegram_user_agent_preferences'::regclass, 'bridge_telegram_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.feishu_user_agent_preferences'::regclass, 'bridge_feishu_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966')
    );

  SELECT count(*)
  INTO v_bridge_object_count
  FROM "pg_trigger" AS "trigger"
  INNER JOIN "pg_proc" AS "function"
    ON "function"."oid" = "trigger"."tgfoid"
  WHERE NOT "trigger"."tgisinternal"
    AND (
      "trigger"."tgname" LIKE 'bridge_%_0966'
      OR "function"."proname" = ANY(ARRAY[
        'bridge_legacy_agent_to_agents_0966',
        'bridge_agent_compose_reference_0966',
        'bridge_default_compose_reference_0966',
        'bridge_selected_compose_reference_0966'
      ]::name[])
    );

  IF v_bridge_trigger_count <> 14 OR v_bridge_object_count <> 14 THEN
    RAISE EXCEPTION 'Canonical Agent repair bridge catalog has exact_pairs %, bridge_objects % instead of 14',
      v_bridge_trigger_count,
      v_bridge_object_count;
  END IF;

  SELECT count(*)
  INTO v_target_trigger_count
  FROM "pg_trigger"
  WHERE "tgrelid" = 'public.agents'::regclass
    AND NOT "tgisinternal";

  IF v_target_trigger_count <> 0 THEN
    RAISE EXCEPTION 'Canonical agents table has % forbidden reverse triggers',
      v_target_trigger_count;
  END IF;

  SELECT count(*)
  INTO v_validated_fk_count
  FROM "pg_constraint"
  WHERE "confrelid" = 'public.agents'::regclass
    AND "contype" = 'f'
    AND "convalidated";

  SELECT count(*)
  INTO v_validated_check_count
  FROM "pg_constraint"
  WHERE "contype" = 'c'
    AND "convalidated"
    AND "conname" = ANY(ARRAY[
      'agent_sessions_agent_reference_match',
      'chat_threads_agent_reference_match',
      'chat_thread_events_agent_reference_match',
      'chat_event_search_messages_agent_reference_match',
      'telegram_installations_agent_reference_match',
      'feishu_org_installations_agent_reference_match',
      'github_installations_agent_reference_match',
      'slack_user_agent_preferences_agent_reference_match',
      'teams_user_agent_preferences_agent_reference_match',
      'agentphone_user_agent_preferences_agent_reference_match',
      'telegram_user_agent_preferences_agent_reference_match',
      'feishu_user_agent_preferences_agent_reference_match'
    ]::name[]);

  SELECT count(*)
  INTO v_valid_index_count
  FROM "pg_class" AS "index"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "index"."relnamespace"
  INNER JOIN "pg_index" AS "index_state"
    ON "index_state"."indexrelid" = "index"."oid"
  WHERE "namespace"."nspname" = 'public'
    AND "index"."relname" = ANY(ARRAY[
      'idx_agents_org_name',
      'idx_agents_org',
      'idx_agent_sessions_user_agent',
      'idx_chat_threads_user_agent_last_message',
      'idx_chat_threads_user_agent_updated',
      'idx_chat_threads_user_agent_pinned',
      'chat_event_search_messages_user_org_agent_id_created_idx'
    ]::name[])
    AND "index_state"."indisready"
    AND "index_state"."indisvalid";

  IF
    v_validated_fk_count <> 18
    OR v_validated_check_count <> 12
    OR v_valid_index_count <> 7
  THEN
    RAISE EXCEPTION 'Canonical Agent repair additive catalog incomplete: validated_fks %, validated_checks %, valid_indexes %',
      v_validated_fk_count,
      v_validated_check_count,
      v_valid_index_count;
  END IF;

  SELECT pg_get_functiondef(
    'public.sync_agent_from_legacy_0966(uuid)'::regprocedure
  ) INTO v_sync_definition;

  IF
    strpos(v_sync_definition, 'pg_advisory_xact_lock') = 0
    OR strpos(v_sync_definition, 'pg_advisory_xact_lock') >
      strpos(v_sync_definition, 'DELETE FROM "agents"')
  THEN
    RAISE EXCEPTION 'Canonical Agent sync does not serialize before source reads';
  END IF;

  SELECT count(*)
  INTO v_temporary_procedure_count
  FROM "pg_proc"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "pg_proc"."pronamespace"
  WHERE "namespace"."nspname" = 'public'
    AND "pg_proc"."proname" = 'repair_canonical_agents_0968';

  IF v_temporary_procedure_count <> 0 THEN
    RAISE EXCEPTION 'Canonical Agent migration left % repair procedures',
      v_temporary_procedure_count;
  END IF;

  RAISE NOTICE 'Canonical Agent repair postflight: matched=%, target=%, compose_only=%, compose_only_null_references=%, deleted_snapshot_anchor_null_references=%, bridges=%, validated_fks=%, validated_checks=%, valid_indexes=%',
    v_matched_count,
    v_target_count,
    v_compose_only_count,
    v_compose_only_null_count,
    v_deleted_snapshot_anchor_null_count,
    v_bridge_trigger_count,
    v_validated_fk_count,
    v_validated_check_count,
    v_valid_index_count;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
