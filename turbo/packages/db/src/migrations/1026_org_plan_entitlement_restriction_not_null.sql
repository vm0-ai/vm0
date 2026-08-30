-- Promote only the canonical restriction column after the accepted expand,
-- backfill, and application authority-switch releases. The 1023 bridge and
-- legacy default remain the mixed-version rollback boundary.
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
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion found legacy NULL canonical-only rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_vm0_models" IS NULL
      AND "restricted_built_in_models" IS NULL
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion found legacy NULL null/null rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_vm0_models" IS NOT NULL
      AND "restricted_built_in_models" IS NOT NULL
      AND "restricted_vm0_models" IS DISTINCT FROM
        "restricted_built_in_models"
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion found unequal dual rows';
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
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion requires the accepted column shape';
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
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion requires the accepted enabled 1023 bridge';
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
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion requires the accepted org metadata helper';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_constraint" AS "constraint_row"
    WHERE "constraint_row"."conrelid" =
      'public.org_plan_entitlements'::regclass
      AND "constraint_row"."conname" =
        'org_plan_entitlements_restricted_built_in_models_not_null_1026'
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion found an unexpected temporary constraint';
  END IF;
END;
$$;
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "restricted_built_in_models" = "restricted_vm0_models"
WHERE "restricted_built_in_models" IS NULL
  AND "restricted_vm0_models" IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_vm0_models" IS NULL
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL reconciliation left legacy NULL rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_built_in_models" IS NULL
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL reconciliation left canonical NULL rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_built_in_models" IS DISTINCT FROM
      "restricted_vm0_models"
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL reconciliation left unequal dual rows';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements"
ADD CONSTRAINT "org_plan_entitlements_restricted_built_in_models_not_null_1026"
CHECK ("restricted_built_in_models" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements"
VALIDATE CONSTRAINT "org_plan_entitlements_restricted_built_in_models_not_null_1026";
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements"
ALTER COLUMN "restricted_built_in_models" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements"
DROP CONSTRAINT "org_plan_entitlements_restricted_built_in_models_not_null_1026";
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
      AND "table_row"."relname" = 'org_plan_entitlements'
      AND "table_row"."relkind" = 'r'
      AND "attribute_row"."attname" = 'restricted_built_in_models'
      AND NOT "attribute_row"."attisdropped"
      AND "attribute_row"."attnotnull"
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
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion produced an unexpected final column shape';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_vm0_models" IS NULL
      OR "restricted_built_in_models" IS NULL
      OR "restricted_vm0_models" IS DISTINCT FROM
        "restricted_built_in_models"
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion produced invalid final data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_constraint" AS "constraint_row"
    WHERE "constraint_row"."conrelid" =
      'public.org_plan_entitlements'::regclass
      AND "constraint_row"."conname" =
        'org_plan_entitlements_restricted_built_in_models_not_null_1026'
  ) THEN
    RAISE EXCEPTION 'Org plan entitlement restriction NOT NULL promotion left the temporary constraint installed';
  END IF;
END;
$$;
