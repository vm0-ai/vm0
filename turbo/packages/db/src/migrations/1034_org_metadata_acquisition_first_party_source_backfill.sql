-- vm0:non-transactional
-- Backfill only historical legacy-only acquisition sources while the exact
-- 1033 OLD/NEW-aware bridge remains installed and authoritative.
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
    FROM "pg_catalog"."pg_attribute" AS "attribute_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "attribute_row"."attrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
      ON "default_row"."adrelid" = "attribute_row"."attrelid"
      AND "default_row"."adnum" = "attribute_row"."attnum"
    WHERE "table_namespace"."nspname" = 'public'
      AND "table_row"."relname" = 'org_metadata'
      AND "table_row"."relkind" = 'r'
      AND "attribute_row"."attname" = 'acquisition_vm0_source'
      AND NOT "attribute_row"."attisdropped"
      AND NOT "attribute_row"."attnotnull"
      AND NOT "attribute_row"."atthasmissing"
      AND "attribute_row"."attidentity" = ''
      AND "attribute_row"."attgenerated" = ''
      AND pg_catalog.format_type(
        "attribute_row"."atttypid", "attribute_row"."atttypmod"
      ) = 'text'
      AND "default_row"."oid" IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_attribute" AS "attribute_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "attribute_row"."attrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
      ON "default_row"."adrelid" = "attribute_row"."attrelid"
      AND "default_row"."adnum" = "attribute_row"."attnum"
    WHERE "table_namespace"."nspname" = 'public'
      AND "table_row"."relname" = 'org_metadata'
      AND "table_row"."relkind" = 'r'
      AND "attribute_row"."attname" =
        'acquisition_first_party_source'
      AND NOT "attribute_row"."attisdropped"
      AND NOT "attribute_row"."attnotnull"
      AND NOT "attribute_row"."atthasmissing"
      AND "attribute_row"."attidentity" = ''
      AND "attribute_row"."attgenerated" = ''
      AND pg_catalog.format_type(
        "attribute_row"."atttypid", "attribute_row"."atttypmod"
      ) = 'text'
      AND "default_row"."oid" IS NULL
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill requires the accepted nullable no-default text columns';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    WHERE "table_namespace"."nspname" = 'public'
      AND "trigger_row"."tgname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "trigger_row"."tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
      ON "function_namespace"."oid" = "function_row"."pronamespace"
    WHERE "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
  ) <> 1 OR NOT EXISTS (
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
      AND "table_row"."relname" = 'org_metadata'
      AND "table_row"."relkind" = 'r'
      AND "trigger_row"."tgname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033 BEFORE INSERT OR UPDATE OF acquisition_vm0_source, acquisition_first_party_source ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION sync_org_metadata_acquisition_first_party_source_1033()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND pg_catalog.pg_get_function_identity_arguments(
        "function_row"."oid"
      ) = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") =
        'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        'b8a4289a4d44a25fbad45fa87f242680'
      AND "function_row"."proowner" = "table_row"."relowner"
      AND "function_row"."prokind" = 'f'
      AND "language_row"."lanname" = 'plpgsql'
      AND NOT "function_row"."prosecdef"
      AND NOT "function_row"."proleakproof"
      AND NOT "function_row"."proisstrict"
      AND NOT "function_row"."proretset"
      AND "function_row"."provolatile" = 'v'
      AND "function_row"."proparallel" = 'u'
      AND "function_row"."proconfig" IS NULL
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill requires the exact enabled 1033 bridge';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_metadata"
    WHERE "acquisition_vm0_source" IS NULL
      AND "acquisition_first_party_source" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill found canonical-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_metadata"
    WHERE "acquisition_vm0_source" IS NOT NULL
      AND "acquisition_first_party_source" IS NOT NULL
      AND "acquisition_vm0_source" IS DISTINCT FROM
        "acquisition_first_party_source"
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill found unequal dual rows';
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Revisit rows skipped below the scan cursor after each complete pass. A
-- bounded no-progress timeout fails closed instead of waiting indefinitely on
-- a row lock.
CREATE OR REPLACE PROCEDURE "backfill_org_metadata_acquisition_first_party_source_1034"(
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after text := NULL;
  v_batch_last_id text;
  v_batch_count integer;
  v_updated_count integer;
  v_remaining boolean;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill no-progress timeout must be between 0 and 30 seconds';
  END IF;

  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  LOOP
    WITH "batch" AS MATERIALIZED (
      SELECT
        "candidate"."org_id",
        "candidate"."acquisition_vm0_source"
      FROM "org_metadata" AS "candidate"
      WHERE (v_scan_after IS NULL OR "candidate"."org_id" > v_scan_after)
        AND "candidate"."acquisition_vm0_source" IS NOT NULL
        AND "candidate"."acquisition_first_party_source" IS NULL
      ORDER BY "candidate"."org_id"
      LIMIT 500
      FOR UPDATE OF "candidate" SKIP LOCKED
    ),
    "updated" AS (
      UPDATE "org_metadata" AS "target"
      SET "acquisition_first_party_source" =
        "batch"."acquisition_vm0_source"
      FROM "batch"
      WHERE "target"."org_id" = "batch"."org_id"
        AND "target"."acquisition_vm0_source" IS NOT NULL
        AND "target"."acquisition_first_party_source" IS NULL
        AND "target"."acquisition_vm0_source" =
          "batch"."acquisition_vm0_source"
      RETURNING "target"."org_id"
    )
    SELECT
      (SELECT count(*)::integer FROM "batch"),
      (SELECT count(*)::integer FROM "updated"),
      (SELECT max("org_id") FROM "batch")
    INTO v_batch_count, v_updated_count, v_batch_last_id;

    IF v_updated_count IS DISTINCT FROM v_batch_count THEN
      RAISE EXCEPTION 'Acquisition first-party source backfill did not update every selected row';
    END IF;

    IF v_batch_count > 0 THEN
      v_scan_after := v_batch_last_id;
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
      FROM "org_metadata"
      WHERE "acquisition_vm0_source" IS NOT NULL
        AND "acquisition_first_party_source" IS NULL
    )
    INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >=
      p_no_progress_timeout
    THEN
      RAISE EXCEPTION 'Acquisition first-party source backfill made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after := NULL;
    PERFORM pg_sleep(0.05);
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "backfill_org_metadata_acquisition_first_party_source_1034"(interval '30 seconds');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_org_metadata_acquisition_first_party_source_1034"(interval);
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
    FROM "org_metadata"
    WHERE "acquisition_vm0_source" IS NOT NULL
      AND "acquisition_first_party_source" IS NULL
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill left legacy-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_metadata"
    WHERE "acquisition_vm0_source" IS NULL
      AND "acquisition_first_party_source" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill left canonical-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_metadata"
    WHERE "acquisition_vm0_source" IS NOT NULL
      AND "acquisition_first_party_source" IS NOT NULL
      AND "acquisition_vm0_source" IS DISTINCT FROM
        "acquisition_first_party_source"
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill left unequal dual rows';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    WHERE "table_namespace"."nspname" = 'public'
      AND "trigger_row"."tgname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "trigger_row"."tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
      ON "function_namespace"."oid" = "function_row"."pronamespace"
    WHERE "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
  ) <> 1 OR NOT EXISTS (
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
      AND "table_row"."relname" = 'org_metadata'
      AND "table_row"."relkind" = 'r'
      AND "trigger_row"."tgname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033 BEFORE INSERT OR UPDATE OF acquisition_vm0_source, acquisition_first_party_source ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION sync_org_metadata_acquisition_first_party_source_1033()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND pg_catalog.pg_get_function_identity_arguments(
        "function_row"."oid"
      ) = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") =
        'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        'b8a4289a4d44a25fbad45fa87f242680'
      AND "function_row"."proowner" = "table_row"."relowner"
      AND "function_row"."prokind" = 'f'
      AND "language_row"."lanname" = 'plpgsql'
      AND NOT "function_row"."prosecdef"
      AND NOT "function_row"."proleakproof"
      AND NOT "function_row"."proisstrict"
      AND NOT "function_row"."proretset"
      AND "function_row"."provolatile" = 'v'
      AND "function_row"."proparallel" = 'u'
      AND "function_row"."proconfig" IS NULL
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill did not preserve the exact enabled 1033 bridge';
  END IF;

  IF to_regprocedure(
    'public.backfill_org_metadata_acquisition_first_party_source_1034(interval)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Acquisition first-party source backfill procedure still exists';
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
