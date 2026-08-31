DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_class" AS "table_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    WHERE "table_namespace"."nspname" = 'public'
      AND "table_row"."relname" = 'org_metadata'
      AND "table_row"."relkind" = 'r'
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source expansion requires public.org_metadata to be a table';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_attribute" AS "attribute_row"
    WHERE "attribute_row"."attrelid" = 'public.org_metadata'::regclass
      AND "attribute_row"."attname" = 'acquisition_first_party_source'
      AND NOT "attribute_row"."attisdropped"
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source expansion found an unexpected canonical column';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_attribute" AS "attribute_row"
    LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
      ON "default_row"."adrelid" = "attribute_row"."attrelid"
      AND "default_row"."adnum" = "attribute_row"."attnum"
    WHERE "attribute_row"."attrelid" = 'public.org_metadata'::regclass
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
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source expansion requires the accepted nullable no-default legacy text column';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
      ON "function_namespace"."oid" = "function_row"."pronamespace"
    WHERE "function_namespace"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
  ) OR EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    WHERE "table_namespace"."nspname" = 'public'
      AND "trigger_row"."tgname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "trigger_row"."tgisinternal"
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source expansion found an unexpected issue-owned bridge identity';
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "org_metadata" ADD COLUMN "acquisition_first_party_source" text;--> statement-breakpoint

-- Temporary #30379 expand/mirror bridge. Surface: DB/API old/new schema skew,
-- observed up to approximately 102 minutes. Keep through the later bounded
-- backfill, application and reporting authority switch, and rollback drain
-- owned by #28368; remove only after exact parity plus the reporting-reader,
-- writer-stop, rollback, and catalog contract gates are accepted.
CREATE FUNCTION public.sync_org_metadata_acquisition_first_party_source_1033()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_changed boolean;
  canonical_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."acquisition_vm0_source" IS NOT NULL
      AND NEW."acquisition_first_party_source" IS NOT NULL
      AND NEW."acquisition_vm0_source" IS DISTINCT FROM
        NEW."acquisition_first_party_source"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'org metadata acquisition first-party sources must match',
        CONSTRAINT = 'org_metadata_acquisition_first_party_source_mirror_check';
    END IF;

    IF NEW."acquisition_vm0_source" IS NULL THEN
      NEW."acquisition_vm0_source" :=
        NEW."acquisition_first_party_source";
    ELSIF NEW."acquisition_first_party_source" IS NULL THEN
      NEW."acquisition_first_party_source" :=
        NEW."acquisition_vm0_source";
    END IF;

    RETURN NEW;
  END IF;

  legacy_changed :=
    NEW."acquisition_vm0_source" IS DISTINCT FROM
      OLD."acquisition_vm0_source";
  canonical_changed :=
    NEW."acquisition_first_party_source" IS DISTINCT FROM
      OLD."acquisition_first_party_source";

  IF legacy_changed AND canonical_changed THEN
    IF NEW."acquisition_vm0_source" IS DISTINCT FROM
      NEW."acquisition_first_party_source"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'org metadata acquisition first-party sources must match',
        CONSTRAINT = 'org_metadata_acquisition_first_party_source_mirror_check';
    END IF;
  ELSIF legacy_changed THEN
    IF NEW."acquisition_vm0_source" IS NULL
      AND NEW."acquisition_first_party_source" IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'org metadata acquisition first-party sources must match',
        CONSTRAINT = 'org_metadata_acquisition_first_party_source_mirror_check';
    END IF;
    NEW."acquisition_first_party_source" :=
      NEW."acquisition_vm0_source";
  ELSIF canonical_changed THEN
    IF NEW."acquisition_first_party_source" IS NULL
      AND NEW."acquisition_vm0_source" IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'org metadata acquisition first-party sources must match',
        CONSTRAINT = 'org_metadata_acquisition_first_party_source_mirror_check';
    END IF;
    NEW."acquisition_vm0_source" :=
      NEW."acquisition_first_party_source";
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033
BEFORE INSERT OR UPDATE OF
  "acquisition_vm0_source", "acquisition_first_party_source"
ON "org_metadata"
FOR EACH ROW
EXECUTE FUNCTION public.sync_org_metadata_acquisition_first_party_source_1033();--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_attribute" AS "attribute_row"
    LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
      ON "default_row"."adrelid" = "attribute_row"."attrelid"
      AND "default_row"."adnum" = "attribute_row"."attnum"
    WHERE "attribute_row"."attrelid" = 'public.org_metadata'::regclass
      AND "attribute_row"."attname" = 'acquisition_first_party_source'
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
      AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
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
      AND pg_catalog.md5("function_row"."prosrc") =
        'b8a4289a4d44a25fbad45fa87f242680'
  ) THEN
    RAISE EXCEPTION 'Acquisition first-party source expansion produced an unexpected final catalog shape';
  END IF;
END;
$$;
