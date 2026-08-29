-- vm0:non-transactional
-- Backfill only historical canonical-NULL entitlement restrictions while the
-- accepted 1023 OLD/NEW-aware bridge remains installed and authoritative.
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
    FROM "org_plan_entitlements"
    WHERE "restricted_vm0_models" IS NULL
      AND "restricted_built_in_models" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill found canonical-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_built_in_models" IS NOT NULL
      AND "restricted_vm0_models" IS DISTINCT FROM
        "restricted_built_in_models"
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill found unequal dual rows';
  END IF;

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
      AND "table_row"."relname" = 'org_plan_entitlements'
      AND "table_row"."relkind" = 'r'
      AND "attribute_row"."attname" = 'restricted_built_in_models'
      AND NOT "attribute_row"."attisdropped"
      AND NOT "attribute_row"."attnotnull"
      AND NOT "attribute_row"."atthasmissing"
      AND "attribute_row"."attidentity" = ''
      AND "attribute_row"."attgenerated" = ''
      AND pg_catalog.format_type(
        "attribute_row"."atttypid", "attribute_row"."atttypmod"
      ) = 'boolean'
      AND "default_row"."oid" IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_attribute" AS "attribute_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "attribute_row"."attrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    INNER JOIN "pg_catalog"."pg_attrdef" AS "default_row"
      ON "default_row"."adrelid" = "attribute_row"."attrelid"
      AND "default_row"."adnum" = "attribute_row"."attnum"
    WHERE "table_namespace"."nspname" = 'public'
      AND "table_row"."relname" = 'org_plan_entitlements'
      AND "table_row"."relkind" = 'r'
      AND "attribute_row"."attname" = 'restricted_vm0_models'
      AND NOT "attribute_row"."attisdropped"
      AND "attribute_row"."attnotnull"
      AND NOT "attribute_row"."atthasmissing"
      AND "attribute_row"."attidentity" = ''
      AND "attribute_row"."attgenerated" = ''
      AND pg_catalog.format_type(
        "attribute_row"."atttypid", "attribute_row"."atttypmod"
      ) = 'boolean'
      AND pg_catalog.pg_get_expr(
        "default_row"."adbin", "default_row"."adrelid"
      ) = 'true'
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill requires the accepted column shape';
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
      AND "table_row"."relname" = 'org_plan_entitlements'
      AND "trigger_row"."tgname" =
        'sync_org_plan_entitlement_model_restrictions_1023'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER sync_org_plan_entitlement_model_restrictions_1023 BEFORE INSERT OR UPDATE OF restricted_vm0_models, restricted_built_in_models ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_org_plan_entitlement_model_restrictions_1023()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_plan_entitlement_model_restrictions_1023'
      AND pg_catalog.pg_get_function_identity_arguments(
        "function_row"."oid"
      ) = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        'c46d67f828e6890bedef54daade5ce43'
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
    RAISE EXCEPTION 'Org plan entitlement restriction backfill requires the accepted enabled 1023 bridge';
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
      AND "table_row"."relname" = 'org_metadata'
      AND "trigger_row"."tgname" =
        'ensure_legacy_org_metadata_plan_entitlement'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'ensure_legacy_org_metadata_plan_entitlement'
      AND pg_catalog.pg_get_function_identity_arguments(
        "function_row"."oid"
      ) = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        'd51c688124a37d0fe34bbabcc8568e97'
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
    RAISE EXCEPTION 'Org plan entitlement restriction backfill requires the accepted org metadata helper';
  END IF;

END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- A text scan cursor avoids rescanning completed rows. Rows skipped below the
-- cursor are revisited after each complete pass, with a bounded no-progress
-- failure for a row that remains locked.
CREATE OR REPLACE PROCEDURE "backfill_org_plan_entitlement_restrictions_1024"(
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after text := NULL;
  v_batch_ids text[];
  v_batch_legacy_values boolean[];
  v_updated_ids text[];
  v_updated_legacy_values boolean[];
  v_updated_canonical_values boolean[];
  v_initial_ids text[];
  v_initial_legacy_values boolean[];
  v_preserved_ids text[];
  v_preserved_legacy_values boolean[];
  v_batch_count integer;
  v_remaining boolean;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill no-progress timeout must be between 0 and 30 seconds';
  END IF;

  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  SELECT
    coalesce(
      array_agg("org_id" ORDER BY "org_id"),
      ARRAY[]::text[]
    ),
    coalesce(
      array_agg("restricted_vm0_models" ORDER BY "org_id"),
      ARRAY[]::boolean[]
    )
  INTO v_initial_ids, v_initial_legacy_values
  FROM "org_plan_entitlements";

  LOOP
    WITH "batch" AS MATERIALIZED (
      SELECT
        "candidate"."org_id",
        "candidate"."restricted_vm0_models"
      FROM "org_plan_entitlements" AS "candidate"
      WHERE (v_scan_after IS NULL OR "candidate"."org_id" > v_scan_after)
        AND "candidate"."restricted_built_in_models" IS NULL
        AND "candidate"."restricted_vm0_models" IS NOT NULL
      ORDER BY "candidate"."org_id"
      LIMIT 500
      FOR UPDATE OF "candidate" SKIP LOCKED
    ),
    "updated" AS (
      UPDATE "org_plan_entitlements" AS "target"
      SET "restricted_built_in_models" =
        "batch"."restricted_vm0_models"
      FROM "batch"
      WHERE "target"."org_id" = "batch"."org_id"
        AND "target"."restricted_built_in_models" IS NULL
        AND "target"."restricted_vm0_models" IS NOT NULL
        AND "target"."restricted_vm0_models" =
          "batch"."restricted_vm0_models"
      RETURNING
        "target"."org_id",
        "target"."restricted_vm0_models",
        "target"."restricted_built_in_models"
    )
    SELECT
      coalesce(
        (SELECT array_agg("org_id" ORDER BY "org_id") FROM "batch"),
        ARRAY[]::text[]
      ),
      coalesce(
        (
          SELECT array_agg(
            "restricted_vm0_models" ORDER BY "org_id"
          )
          FROM "batch"
        ),
        ARRAY[]::boolean[]
      ),
      coalesce(
        (SELECT array_agg("org_id" ORDER BY "org_id") FROM "updated"),
        ARRAY[]::text[]
      ),
      coalesce(
        (
          SELECT array_agg(
            "restricted_vm0_models" ORDER BY "org_id"
          )
          FROM "updated"
        ),
        ARRAY[]::boolean[]
      ),
      coalesce(
        (
          SELECT array_agg(
            "restricted_built_in_models" ORDER BY "org_id"
          )
          FROM "updated"
        ),
        ARRAY[]::boolean[]
      )
    INTO
      v_batch_ids,
      v_batch_legacy_values,
      v_updated_ids,
      v_updated_legacy_values,
      v_updated_canonical_values;

    v_batch_count := cardinality(v_batch_ids);

    IF v_updated_ids IS DISTINCT FROM v_batch_ids
      OR v_updated_legacy_values IS DISTINCT FROM v_batch_legacy_values
      OR v_updated_canonical_values IS DISTINCT FROM v_batch_legacy_values
    THEN
      RAISE EXCEPTION 'Org plan entitlement restriction backfill did not preserve and update every selected row';
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
      FROM "org_plan_entitlements"
      WHERE "restricted_built_in_models" IS NULL
    )
    INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
      RAISE EXCEPTION 'Org plan entitlement restriction backfill made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after := NULL;
    PERFORM pg_sleep(0.05);
  END LOOP;

  SELECT coalesce(
    array_agg("org_id" ORDER BY "org_id"),
    ARRAY[]::text[]
  )
  INTO v_preserved_ids
  FROM "org_plan_entitlements"
  WHERE "org_id" = ANY(v_initial_ids);

  IF v_preserved_ids IS DISTINCT FROM v_initial_ids THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill did not preserve initial row identities and count';
  END IF;

  SELECT coalesce(
    array_agg("restricted_vm0_models" ORDER BY "org_id"),
    ARRAY[]::boolean[]
  )
  INTO v_preserved_legacy_values
  FROM "org_plan_entitlements"
  WHERE "org_id" = ANY(v_initial_ids);

  IF v_preserved_legacy_values IS DISTINCT FROM
    v_initial_legacy_values
  THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill did not preserve initial legacy values';
  END IF;
END;
$$;
--> statement-breakpoint
CALL "backfill_org_plan_entitlement_restrictions_1024"(interval '30 seconds');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_org_plan_entitlement_restrictions_1024"(interval);
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
    FROM "org_plan_entitlements"
    WHERE "restricted_built_in_models" IS NULL
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill left canonical NULL rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_vm0_models" IS NULL
      AND "restricted_built_in_models" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill left canonical-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_built_in_models" IS DISTINCT FROM
      "restricted_vm0_models"
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill left unequal dual rows';
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
      AND "table_row"."relname" = 'org_plan_entitlements'
      AND "trigger_row"."tgname" =
        'sync_org_plan_entitlement_model_restrictions_1023'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER sync_org_plan_entitlement_model_restrictions_1023 BEFORE INSERT OR UPDATE OF restricted_vm0_models, restricted_built_in_models ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_org_plan_entitlement_model_restrictions_1023()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_plan_entitlement_model_restrictions_1023'
      AND pg_catalog.pg_get_function_identity_arguments(
        "function_row"."oid"
      ) = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        'c46d67f828e6890bedef54daade5ce43'
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
    RAISE EXCEPTION 'Org plan entitlement restriction backfill did not preserve the accepted enabled 1023 bridge';
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
      AND "table_row"."relname" = 'org_metadata'
      AND "trigger_row"."tgname" =
        'ensure_legacy_org_metadata_plan_entitlement'
      AND NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgenabled" = 'O'
      AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
        'CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()'
      AND "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'ensure_legacy_org_metadata_plan_entitlement'
      AND pg_catalog.pg_get_function_identity_arguments(
        "function_row"."oid"
      ) = ''
      AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
      AND pg_catalog.md5("function_row"."prosrc") =
        'd51c688124a37d0fe34bbabcc8568e97'
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
    RAISE EXCEPTION 'Org plan entitlement restriction backfill did not preserve the accepted org metadata helper';
  END IF;

  IF to_regprocedure(
    'public.backfill_org_plan_entitlement_restrictions_1024(interval)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Org plan entitlement restriction backfill procedure still exists';
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
