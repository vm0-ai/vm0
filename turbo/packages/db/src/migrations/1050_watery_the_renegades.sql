SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- No writer can cross the final catalog and pair-state boundary.
LOCK TABLE "org_metadata" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
  metadata_oid oid;
  org_id_attnum smallint;
  legacy_attnum smallint;
  canonical_attnum smallint;
  primary_constraint_oid oid;
  bridge_trigger_oid oid;
  bridge_function_oid oid;
  acquisition_columns jsonb;
  unexpected_objects text[];
  routine_references text[];
BEGIN
  SELECT "relation_row"."oid"
  INTO metadata_oid
  FROM "pg_catalog"."pg_class" AS "relation_row"
  INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
    ON "namespace_row"."oid" = "relation_row"."relnamespace"
  WHERE "namespace_row"."nspname" = 'public'
    AND "relation_row"."relname" = 'org_metadata'
    AND "relation_row"."relkind" = 'r'
    AND "relation_row"."relpersistence" = 'p';

  IF metadata_oid IS NULL THEN
    RAISE EXCEPTION 'Acquisition source contract requires an ordinary permanent org_metadata table';
  END IF;

  SELECT jsonb_object_agg(
    "attribute_row"."attname",
    jsonb_build_object(
      'type', pg_catalog.format_type(
        "attribute_row"."atttypid",
        "attribute_row"."atttypmod"
      ),
      'notNull', "attribute_row"."attnotnull",
      'hasDefault', "attribute_row"."atthasdef",
      'default', pg_catalog.pg_get_expr(
        "default_row"."adbin",
        "default_row"."adrelid"
      ),
      'identity', "attribute_row"."attidentity",
      'generated', "attribute_row"."attgenerated",
      'hasMissing', "attribute_row"."atthasmissing"
    )
  )
  INTO acquisition_columns
  FROM "pg_catalog"."pg_attribute" AS "attribute_row"
  LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
    ON "default_row"."adrelid" = "attribute_row"."attrelid"
    AND "default_row"."adnum" = "attribute_row"."attnum"
  WHERE "attribute_row"."attrelid" = metadata_oid
    AND "attribute_row"."attname" IN (
      'org_id',
      'acquisition_vm0_source',
      'acquisition_first_party_source'
    )
    AND "attribute_row"."attnum" > 0
    AND NOT "attribute_row"."attisdropped";

  IF acquisition_columns IS DISTINCT FROM jsonb_build_object(
    'org_id', jsonb_build_object(
      'type', 'text',
      'notNull', true,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'acquisition_vm0_source', jsonb_build_object(
      'type', 'text',
      'notNull', false,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'acquisition_first_party_source', jsonb_build_object(
      'type', 'text',
      'notNull', false,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    )
  ) THEN
    RAISE EXCEPTION 'Acquisition source contract found unexpected column catalog: %', acquisition_columns;
  END IF;

  SELECT "attnum"
  INTO org_id_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = metadata_oid
    AND "attname" = 'org_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO legacy_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = metadata_oid
    AND "attname" = 'acquisition_vm0_source'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO canonical_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = metadata_oid
    AND "attname" = 'acquisition_first_party_source'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "constraint_row"."oid"
  INTO primary_constraint_oid
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  INNER JOIN "pg_catalog"."pg_index" AS "index_row"
    ON "index_row"."indexrelid" = "constraint_row"."conindid"
  WHERE "constraint_row"."conrelid" = metadata_oid
    AND "constraint_row"."conname" = 'org_metadata_pkey'
    AND "constraint_row"."contype" = 'p'
    AND "constraint_row"."convalidated"
    AND NOT "constraint_row"."condeferrable"
    AND NOT "constraint_row"."condeferred"
    AND "constraint_row"."conislocal"
    AND "constraint_row"."coninhcount" = 0
    AND "constraint_row"."connoinherit"
    AND "constraint_row"."conkey" = ARRAY[org_id_attnum]::smallint[]
    AND pg_catalog.pg_get_constraintdef(
      "constraint_row"."oid",
      true
    ) = 'PRIMARY KEY (org_id)'
    AND "index_row"."indrelid" = metadata_oid
    AND "index_row"."indisunique"
    AND "index_row"."indisprimary"
    AND "index_row"."indisvalid"
    AND "index_row"."indisready"
    AND "index_row"."indnkeyatts" = 1
    AND "index_row"."indnatts" = 1
    AND "index_row"."indkey"::text = org_id_attnum::text
    AND "index_row"."indpred" IS NULL
    AND "index_row"."indexprs" IS NULL
    AND pg_catalog.pg_get_indexdef("index_row"."indexrelid") =
      'CREATE UNIQUE INDEX org_metadata_pkey ON public.org_metadata USING btree (org_id)';

  IF primary_constraint_oid IS NULL OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_constraint"
    WHERE "conrelid" = metadata_oid
      AND "contype" = 'p'
  ) <> 1 THEN
    RAISE EXCEPTION 'Acquisition source contract requires the exact org_id primary key';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgname" =
      'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
  ) <> 1 THEN
    RAISE EXCEPTION 'Acquisition source contract requires exactly one 1033 bridge trigger and function';
  END IF;

  SELECT "trigger_row"."oid", "function_row"."oid"
  INTO bridge_trigger_oid, bridge_function_oid
  FROM "pg_catalog"."pg_trigger" AS "trigger_row"
  INNER JOIN "pg_catalog"."pg_class" AS "table_row"
    ON "table_row"."oid" = "trigger_row"."tgrelid"
  INNER JOIN "pg_catalog"."pg_proc" AS "function_row"
    ON "function_row"."oid" = "trigger_row"."tgfoid"
  INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
    ON "function_namespace"."oid" = "function_row"."pronamespace"
  INNER JOIN "pg_catalog"."pg_language" AS "language_row"
    ON "language_row"."oid" = "function_row"."prolang"
  WHERE "trigger_row"."tgrelid" = metadata_oid
    AND "trigger_row"."tgname" =
      'sync_org_metadata_acquisition_first_party_source_1033'
    AND NOT "trigger_row"."tgisinternal"
    AND "trigger_row"."tgenabled" = 'O'
    AND NOT "trigger_row"."tgdeferrable"
    AND NOT "trigger_row"."tginitdeferred"
    AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
      'CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033 BEFORE INSERT OR UPDATE OF acquisition_vm0_source, acquisition_first_party_source ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION sync_org_metadata_acquisition_first_party_source_1033()'
    AND "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" =
      'sync_org_metadata_acquisition_first_party_source_1033'
    AND "function_row"."prokind" = 'f'
    AND pg_catalog.pg_get_function_identity_arguments(
      "function_row"."oid"
    ) = ''
    AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
    AND pg_catalog.md5("function_row"."prosrc") =
      'b8a4289a4d44a25fbad45fa87f242680'
    AND "function_row"."proowner" = "table_row"."relowner"
    AND "language_row"."lanname" = 'plpgsql'
    AND NOT "function_row"."prosecdef"
    AND NOT "function_row"."proleakproof"
    AND NOT "function_row"."proisstrict"
    AND NOT "function_row"."proretset"
    AND "function_row"."provolatile" = 'v'
    AND "function_row"."proparallel" = 'u'
    AND "function_row"."proconfig" IS NULL;

  IF bridge_trigger_oid IS NULL OR bridge_function_oid IS NULL THEN
    RAISE EXCEPTION 'Acquisition source contract requires the accepted enabled 1033 bridge identity';
  END IF;

  SELECT array_agg(
    DISTINCT pg_catalog.pg_describe_object(
      "dependency_row"."classid",
      "dependency_row"."objid",
      "dependency_row"."objsubid"
    )
    ORDER BY pg_catalog.pg_describe_object(
      "dependency_row"."classid",
      "dependency_row"."objid",
      "dependency_row"."objsubid"
    )
  )
  INTO unexpected_objects
  FROM "pg_catalog"."pg_depend" AS "dependency_row"
  WHERE "dependency_row"."refclassid" = 'pg_class'::regclass
    AND "dependency_row"."refobjid" = metadata_oid
    AND "dependency_row"."refobjsubid" IN (
      legacy_attnum,
      canonical_attnum
    )
    AND NOT (
      "dependency_row"."classid" = 'pg_trigger'::regclass
      AND "dependency_row"."objid" = bridge_trigger_oid
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Acquisition source contract found unexpected column dependencies: %', unexpected_objects;
  END IF;

  WITH "stored_routines" AS MATERIALIZED (
    SELECT
      "namespace_row"."nspname" AS "schema_name",
      "function_row"."proname" AS "function_name",
      pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
        AS "identity_arguments",
      pg_catalog.pg_get_functiondef("function_row"."oid") AS "definition"
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "function_row"."prokind" IN ('f', 'p')
      AND "namespace_row"."nspname" NOT IN (
        'pg_catalog',
        'information_schema'
      )
      AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'
  )
  SELECT array_agg(
    format(
      '%I.%I(%s)',
      "schema_name",
      "function_name",
      "identity_arguments"
    )
    ORDER BY "schema_name", "function_name", "identity_arguments"
  )
  INTO routine_references
  FROM "stored_routines"
  WHERE "definition" ~* '\macquisition_vm0_source\M';

  IF routine_references IS DISTINCT FROM ARRAY[
    'public.sync_org_metadata_acquisition_first_party_source_1033()'
  ]::text[] THEN
    RAISE EXCEPTION 'Acquisition source contract found unexpected routines referencing acquisition_vm0_source: %', routine_references;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_metadata"
    WHERE "acquisition_vm0_source" IS DISTINCT FROM
      "acquisition_first_party_source"
  ) THEN
    RAISE EXCEPTION 'Acquisition source contract requires matching nullable acquisition pairs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_metadata" AS "metadata_row"
    WHERE pg_catalog.jsonb_typeof(
      pg_catalog.to_jsonb("metadata_row") -> 'org_id'
    ) = 'null'
  ) OR EXISTS (
    SELECT 1
    FROM "org_metadata"
    GROUP BY "org_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Acquisition source contract requires unique non-NULL org_id values';
  END IF;
END;
$$;--> statement-breakpoint

CREATE TEMP TABLE "org_metadata_acquisition_contract_state_1050"
ON COMMIT DROP
AS
SELECT
  count(*)::bigint AS "row_count",
  pg_catalog.md5(
    COALESCE(
      jsonb_agg(
        jsonb_build_array("org_id", "acquisition_first_party_source")
        ORDER BY "org_id"
      ),
      '[]'::jsonb
    )::text
  ) AS "canonical_fingerprint"
FROM "org_metadata";--> statement-breakpoint

DROP TRIGGER "sync_org_metadata_acquisition_first_party_source_1033"
ON "org_metadata";--> statement-breakpoint

DROP FUNCTION public."sync_org_metadata_acquisition_first_party_source_1033"();--> statement-breakpoint

ALTER TABLE "org_metadata"
DROP COLUMN "acquisition_vm0_source";--> statement-breakpoint

DO $$
DECLARE
  metadata_oid oid;
  org_id_attnum smallint;
  canonical_attnum smallint;
  primary_constraint_oid oid;
  acquisition_columns jsonb;
  unexpected_objects text[];
  routine_references text[];
  before_row_count bigint;
  after_row_count bigint;
  before_fingerprint text;
  after_fingerprint text;
BEGIN
  SELECT "relation_row"."oid"
  INTO metadata_oid
  FROM "pg_catalog"."pg_class" AS "relation_row"
  INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
    ON "namespace_row"."oid" = "relation_row"."relnamespace"
  WHERE "namespace_row"."nspname" = 'public'
    AND "relation_row"."relname" = 'org_metadata'
    AND "relation_row"."relkind" = 'r'
    AND "relation_row"."relpersistence" = 'p';

  IF metadata_oid IS NULL THEN
    RAISE EXCEPTION 'Acquisition source contract postcondition lost org_metadata';
  END IF;

  SELECT jsonb_object_agg(
    "attribute_row"."attname",
    jsonb_build_object(
      'type', pg_catalog.format_type(
        "attribute_row"."atttypid",
        "attribute_row"."atttypmod"
      ),
      'notNull', "attribute_row"."attnotnull",
      'hasDefault', "attribute_row"."atthasdef",
      'default', pg_catalog.pg_get_expr(
        "default_row"."adbin",
        "default_row"."adrelid"
      ),
      'identity', "attribute_row"."attidentity",
      'generated', "attribute_row"."attgenerated",
      'hasMissing', "attribute_row"."atthasmissing"
    )
  )
  INTO acquisition_columns
  FROM "pg_catalog"."pg_attribute" AS "attribute_row"
  LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
    ON "default_row"."adrelid" = "attribute_row"."attrelid"
    AND "default_row"."adnum" = "attribute_row"."attnum"
  WHERE "attribute_row"."attrelid" = metadata_oid
    AND "attribute_row"."attname" IN (
      'org_id',
      'acquisition_vm0_source',
      'acquisition_first_party_source'
    )
    AND "attribute_row"."attnum" > 0
    AND NOT "attribute_row"."attisdropped";

  IF acquisition_columns IS DISTINCT FROM jsonb_build_object(
    'org_id', jsonb_build_object(
      'type', 'text',
      'notNull', true,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'acquisition_first_party_source', jsonb_build_object(
      'type', 'text',
      'notNull', false,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    )
  ) THEN
    RAISE EXCEPTION 'Acquisition source contract produced unexpected canonical columns: %', acquisition_columns;
  END IF;

  SELECT "attnum"
  INTO org_id_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = metadata_oid
    AND "attname" = 'org_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO canonical_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = metadata_oid
    AND "attname" = 'acquisition_first_party_source'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "constraint_row"."oid"
  INTO primary_constraint_oid
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  INNER JOIN "pg_catalog"."pg_index" AS "index_row"
    ON "index_row"."indexrelid" = "constraint_row"."conindid"
  WHERE "constraint_row"."conrelid" = metadata_oid
    AND "constraint_row"."conname" = 'org_metadata_pkey'
    AND "constraint_row"."contype" = 'p'
    AND "constraint_row"."convalidated"
    AND NOT "constraint_row"."condeferrable"
    AND NOT "constraint_row"."condeferred"
    AND "constraint_row"."conislocal"
    AND "constraint_row"."coninhcount" = 0
    AND "constraint_row"."connoinherit"
    AND "constraint_row"."conkey" = ARRAY[org_id_attnum]::smallint[]
    AND pg_catalog.pg_get_constraintdef(
      "constraint_row"."oid",
      true
    ) = 'PRIMARY KEY (org_id)'
    AND "index_row"."indrelid" = metadata_oid
    AND "index_row"."indisunique"
    AND "index_row"."indisprimary"
    AND "index_row"."indisvalid"
    AND "index_row"."indisready"
    AND "index_row"."indnkeyatts" = 1
    AND "index_row"."indnatts" = 1
    AND "index_row"."indkey"::text = org_id_attnum::text
    AND "index_row"."indpred" IS NULL
    AND "index_row"."indexprs" IS NULL
    AND pg_catalog.pg_get_indexdef("index_row"."indexrelid") =
      'CREATE UNIQUE INDEX org_metadata_pkey ON public.org_metadata USING btree (org_id)';

  IF primary_constraint_oid IS NULL OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_constraint"
    WHERE "conrelid" = metadata_oid
      AND "contype" = 'p'
  ) <> 1 THEN
    RAISE EXCEPTION 'Acquisition source contract changed the org_id primary key';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgname" =
      'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "tgisinternal"
  ) OR EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
  ) THEN
    RAISE EXCEPTION 'Acquisition source contract did not remove the exact 1033 bridge';
  END IF;

  SELECT array_agg(
    DISTINCT pg_catalog.pg_describe_object(
      "dependency_row"."classid",
      "dependency_row"."objid",
      "dependency_row"."objsubid"
    )
    ORDER BY pg_catalog.pg_describe_object(
      "dependency_row"."classid",
      "dependency_row"."objid",
      "dependency_row"."objsubid"
    )
  )
  INTO unexpected_objects
  FROM "pg_catalog"."pg_depend" AS "dependency_row"
  WHERE "dependency_row"."refclassid" = 'pg_class'::regclass
    AND "dependency_row"."refobjid" = metadata_oid
    AND "dependency_row"."refobjsubid" = canonical_attnum;

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Acquisition source contract produced unexpected canonical dependencies: %', unexpected_objects;
  END IF;

  WITH "stored_routines" AS MATERIALIZED (
    SELECT
      "namespace_row"."nspname" AS "schema_name",
      "function_row"."proname" AS "function_name",
      pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
        AS "identity_arguments",
      pg_catalog.pg_get_functiondef("function_row"."oid") AS "definition"
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "function_row"."prokind" IN ('f', 'p')
      AND "namespace_row"."nspname" NOT IN (
        'pg_catalog',
        'information_schema'
      )
      AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'
  )
  SELECT array_agg(
    format(
      '%I.%I(%s)',
      "schema_name",
      "function_name",
      "identity_arguments"
    )
    ORDER BY "schema_name", "function_name", "identity_arguments"
  )
  INTO routine_references
  FROM "stored_routines"
  WHERE "definition" ~* '\macquisition_vm0_source\M';

  IF routine_references IS NOT NULL THEN
    RAISE EXCEPTION 'Acquisition source contract retained routines referencing acquisition_vm0_source: %', routine_references;
  END IF;

  SELECT "row_count", "canonical_fingerprint"
  INTO before_row_count, before_fingerprint
  FROM "org_metadata_acquisition_contract_state_1050";

  SELECT
    count(*)::bigint,
    pg_catalog.md5(
      COALESCE(
        jsonb_agg(
          jsonb_build_array("org_id", "acquisition_first_party_source")
          ORDER BY "org_id"
        ),
        '[]'::jsonb
      )::text
    )
  INTO after_row_count, after_fingerprint
  FROM "org_metadata";

  IF before_row_count IS DISTINCT FROM after_row_count
    OR before_fingerprint IS DISTINCT FROM after_fingerprint
  THEN
    RAISE EXCEPTION 'Acquisition source contract did not preserve the canonical row set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_metadata" AS "metadata_row"
    WHERE pg_catalog.jsonb_typeof(
      pg_catalog.to_jsonb("metadata_row") -> 'org_id'
    ) = 'null'
  ) OR EXISTS (
    SELECT 1
    FROM "org_metadata"
    GROUP BY "org_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Acquisition source contract lost unique non-NULL org_id values';
  END IF;
END;
$$;
