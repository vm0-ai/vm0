-- vm0:non-transactional
-- Backfill only historical legacy-only Agent Run model key identities while
-- the 0971 OLD/NEW-aware bridge remains installed and authoritative.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    INNER JOIN "pg_catalog"."pg_proc" AS "function_row"
      ON "function_row"."oid" = "trigger_row"."tgfoid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
      ON "function_namespace"."oid" = "function_row"."pronamespace"
    INNER JOIN "pg_catalog"."pg_language" AS "language_row"
      ON "language_row"."oid" = "function_row"."prolang"
    WHERE "table_namespace"."nspname" = 'public'
      AND "table_row"."relname" = 'agent_runs'
      AND "trigger_row"."tgname" = 'sync_agent_run_model_key_ids_0971'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER sync_agent_run_model_key_ids_0971 BEFORE INSERT OR UPDATE OF vm0_model_key_id, built_in_model_key_id ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION sync_agent_run_model_key_ids_0971()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" = 'sync_agent_run_model_key_ids_0971'
      AND pg_catalog.pg_get_function_identity_arguments("function_row"."oid") = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        '0cb34f89e8724080310d14f837a3b762'
      AND "function_row"."proowner" = "table_row"."relowner"
      AND "language_row"."lanname" = 'plpgsql'
      AND NOT "function_row"."prosecdef"
      AND NOT "function_row"."proisstrict"
      AND "function_row"."provolatile" = 'v'
      AND "function_row"."proparallel" = 'u'
  ) THEN
    RAISE EXCEPTION 'Agent Run model key backfill requires the accepted enabled 0971 bridge';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "vm0_model_key_id" IS NULL
      AND "built_in_model_key_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Agent Run model key backfill found canonical-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "vm0_model_key_id" IS NOT NULL
      AND "built_in_model_key_id" IS NOT NULL
      AND "vm0_model_key_id" IS DISTINCT FROM "built_in_model_key_id"
  ) THEN
    RAISE EXCEPTION 'Agent Run model key backfill found unequal dual rows';
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- A UUID scan cursor avoids rescanning completed rows. Rows skipped below the
-- cursor are revisited after each complete pass, with a bounded no-progress
-- failure for a row that remains locked.
CREATE OR REPLACE PROCEDURE "backfill_agent_run_built_in_model_key_ids_0973"(
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after uuid := NULL;
  v_batch_ids uuid[];
  v_updated_ids uuid[];
  v_batch_count integer;
  v_remaining boolean;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Agent Run model key backfill no-progress timeout must be between 0 and 30 seconds';
  END IF;

  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  LOOP
    WITH "batch" AS MATERIALIZED (
      SELECT
        "candidate"."id",
        "candidate"."vm0_model_key_id"
      FROM "agent_runs" AS "candidate"
      WHERE (v_scan_after IS NULL OR "candidate"."id" > v_scan_after)
        AND "candidate"."vm0_model_key_id" IS NOT NULL
        AND "candidate"."built_in_model_key_id" IS NULL
      ORDER BY "candidate"."id"
      LIMIT 500
      FOR UPDATE OF "candidate" SKIP LOCKED
    ),
    "updated" AS (
      UPDATE "agent_runs" AS "target"
      SET "built_in_model_key_id" = "batch"."vm0_model_key_id"
      FROM "batch"
      WHERE "target"."id" = "batch"."id"
        AND "target"."vm0_model_key_id" IS NOT NULL
        AND "target"."built_in_model_key_id" IS NULL
      RETURNING "target"."id"
    )
    SELECT
      coalesce(
        (SELECT array_agg("id" ORDER BY "id") FROM "batch"),
        ARRAY[]::uuid[]
      ),
      coalesce(
        (SELECT array_agg("id" ORDER BY "id") FROM "updated"),
        ARRAY[]::uuid[]
      )
    INTO v_batch_ids, v_updated_ids;

    v_batch_count := cardinality(v_batch_ids);

    IF v_updated_ids IS DISTINCT FROM v_batch_ids THEN
      RAISE EXCEPTION 'Agent Run model key backfill did not update every selected row';
    END IF;

    IF v_batch_count > 0 THEN
      v_scan_after := v_batch_ids[v_batch_count];
      v_no_progress_started_at := clock_timestamp();
    END IF;

    COMMIT;
    SET LOCAL lock_timeout = '1s';
    SET LOCAL transaction_timeout = '5min';

    IF v_batch_count > 0 THEN
      PERFORM pg_sleep(0.05);
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "agent_runs"
      WHERE "vm0_model_key_id" IS NOT NULL
        AND "built_in_model_key_id" IS NULL
    )
    INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
      RAISE EXCEPTION 'Agent Run model key backfill made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after := NULL;
    PERFORM pg_sleep(0.05);
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "backfill_agent_run_built_in_model_key_ids_0973"(interval '30 seconds');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_agent_run_built_in_model_key_ids_0973"(interval);
--> statement-breakpoint

BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "vm0_model_key_id" IS NOT NULL
      AND "built_in_model_key_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Agent Run model key backfill left legacy-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "vm0_model_key_id" IS NULL
      AND "built_in_model_key_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Agent Run model key backfill left canonical-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "vm0_model_key_id" IS NOT NULL
      AND "built_in_model_key_id" IS NOT NULL
      AND "vm0_model_key_id" IS DISTINCT FROM "built_in_model_key_id"
  ) THEN
    RAISE EXCEPTION 'Agent Run model key backfill left unequal dual rows';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    INNER JOIN "pg_catalog"."pg_proc" AS "function_row"
      ON "function_row"."oid" = "trigger_row"."tgfoid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
      ON "function_namespace"."oid" = "function_row"."pronamespace"
    INNER JOIN "pg_catalog"."pg_language" AS "language_row"
      ON "language_row"."oid" = "function_row"."prolang"
    WHERE "table_namespace"."nspname" = 'public'
      AND "table_row"."relname" = 'agent_runs'
      AND "trigger_row"."tgname" = 'sync_agent_run_model_key_ids_0971'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER sync_agent_run_model_key_ids_0971 BEFORE INSERT OR UPDATE OF vm0_model_key_id, built_in_model_key_id ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION sync_agent_run_model_key_ids_0971()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" = 'sync_agent_run_model_key_ids_0971'
      AND pg_catalog.pg_get_function_identity_arguments("function_row"."oid") = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        '0cb34f89e8724080310d14f837a3b762'
      AND "function_row"."proowner" = "table_row"."relowner"
      AND "language_row"."lanname" = 'plpgsql'
      AND NOT "function_row"."prosecdef"
      AND NOT "function_row"."proisstrict"
      AND "function_row"."provolatile" = 'v'
      AND "function_row"."proparallel" = 'u'
  ) THEN
    RAISE EXCEPTION 'Agent Run model key backfill did not preserve the accepted enabled 0971 bridge';
  END IF;

  IF to_regprocedure(
    'public.backfill_agent_run_built_in_model_key_ids_0973(interval)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Agent Run model key backfill procedure still exists';
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
