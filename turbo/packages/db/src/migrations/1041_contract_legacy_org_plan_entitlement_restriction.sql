SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Match the org-metadata bootstrap lock order before taking the final bounded
-- entitlement contract boundary. No writer can cross the catalog/parity check.
LOCK TABLE
  "org_metadata",
  "org_plan_entitlements"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
  org_metadata_oid oid;
  entitlement_oid oid;
  org_id_attnum smallint;
  legacy_attnum smallint;
  canonical_attnum smallint;
  legacy_default_oid oid;
  primary_constraint_oid oid;
  primary_index_oid oid;
  helper_trigger_oid oid;
  helper_function_oid oid;
  bridge_trigger_oid oid;
  bridge_function_oid oid;
  restriction_columns jsonb;
  unexpected_objects text[];
  routine_references text[];
BEGIN
  SELECT "relation_row"."oid"
  INTO org_metadata_oid
  FROM "pg_catalog"."pg_class" AS "relation_row"
  INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
    ON "namespace_row"."oid" = "relation_row"."relnamespace"
  WHERE "namespace_row"."nspname" = 'public'
    AND "relation_row"."relname" = 'org_metadata'
    AND "relation_row"."relkind" = 'r'
    AND "relation_row"."relpersistence" = 'p';

  SELECT "relation_row"."oid"
  INTO entitlement_oid
  FROM "pg_catalog"."pg_class" AS "relation_row"
  INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
    ON "namespace_row"."oid" = "relation_row"."relnamespace"
  WHERE "namespace_row"."nspname" = 'public'
    AND "relation_row"."relname" = 'org_plan_entitlements'
    AND "relation_row"."relkind" = 'r'
    AND "relation_row"."relpersistence" = 'p';

  IF org_metadata_oid IS NULL OR entitlement_oid IS NULL THEN
    RAISE EXCEPTION 'Entitlement contract requires ordinary permanent org_metadata and org_plan_entitlements tables';
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
  INTO restriction_columns
  FROM "pg_catalog"."pg_attribute" AS "attribute_row"
  LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
    ON "default_row"."adrelid" = "attribute_row"."attrelid"
    AND "default_row"."adnum" = "attribute_row"."attnum"
  WHERE "attribute_row"."attrelid" = entitlement_oid
    AND "attribute_row"."attname" IN (
      'org_id',
      'restricted_vm0_models',
      'restricted_built_in_models'
    )
    AND "attribute_row"."attnum" > 0
    AND NOT "attribute_row"."attisdropped";

  IF restriction_columns IS DISTINCT FROM jsonb_build_object(
    'org_id', jsonb_build_object(
      'type', 'text',
      'notNull', true,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'restricted_vm0_models', jsonb_build_object(
      'type', 'boolean',
      'notNull', true,
      'hasDefault', true,
      'default', 'true',
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'restricted_built_in_models', jsonb_build_object(
      'type', 'boolean',
      'notNull', true,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    )
  ) THEN
    RAISE EXCEPTION 'Entitlement contract found unexpected restriction column catalog: %', restriction_columns;
  END IF;

  SELECT "attnum"
  INTO org_id_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = entitlement_oid
    AND "attname" = 'org_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO legacy_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = entitlement_oid
    AND "attname" = 'restricted_vm0_models'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO canonical_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = entitlement_oid
    AND "attname" = 'restricted_built_in_models'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "oid"
  INTO legacy_default_oid
  FROM "pg_catalog"."pg_attrdef"
  WHERE "adrelid" = entitlement_oid
    AND "adnum" = legacy_attnum
    AND pg_catalog.pg_get_expr("adbin", "adrelid") = 'true';

  SELECT "constraint_row"."oid", "constraint_row"."conindid"
  INTO primary_constraint_oid, primary_index_oid
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  INNER JOIN "pg_catalog"."pg_index" AS "index_row"
    ON "index_row"."indexrelid" = "constraint_row"."conindid"
  WHERE "constraint_row"."conrelid" = entitlement_oid
    AND "constraint_row"."conname" = 'org_plan_entitlements_pkey'
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
    AND "index_row"."indrelid" = entitlement_oid
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
      'CREATE UNIQUE INDEX org_plan_entitlements_pkey ON public.org_plan_entitlements USING btree (org_id)';

  IF primary_constraint_oid IS NULL OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_constraint"
    WHERE "conrelid" = entitlement_oid
      AND "contype" = 'p'
  ) <> 1 THEN
    RAISE EXCEPTION 'Entitlement contract requires the exact org_id primary key';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgname" = 'ensure_legacy_org_metadata_plan_entitlement'
      AND NOT "tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'ensure_legacy_org_metadata_plan_entitlement'
  ) <> 1 THEN
    RAISE EXCEPTION 'Entitlement contract requires exactly one org metadata helper trigger and function';
  END IF;

  SELECT "trigger_row"."oid", "function_row"."oid"
  INTO helper_trigger_oid, helper_function_oid
  FROM "pg_catalog"."pg_trigger" AS "trigger_row"
  INNER JOIN "pg_catalog"."pg_class" AS "table_row"
    ON "table_row"."oid" = "trigger_row"."tgrelid"
  INNER JOIN "pg_catalog"."pg_proc" AS "function_row"
    ON "function_row"."oid" = "trigger_row"."tgfoid"
  INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
    ON "function_namespace"."oid" = "function_row"."pronamespace"
  INNER JOIN "pg_catalog"."pg_language" AS "language_row"
    ON "language_row"."oid" = "function_row"."prolang"
  WHERE "trigger_row"."tgrelid" = org_metadata_oid
    AND "trigger_row"."tgname" =
      'ensure_legacy_org_metadata_plan_entitlement'
    AND NOT "trigger_row"."tgisinternal"
    AND "trigger_row"."tgenabled" = 'O'
    AND NOT "trigger_row"."tgdeferrable"
    AND NOT "trigger_row"."tginitdeferred"
    AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
      'CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()'
    AND "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" =
      'ensure_legacy_org_metadata_plan_entitlement'
    AND "function_row"."prokind" = 'f'
    AND pg_catalog.pg_get_function_identity_arguments(
      "function_row"."oid"
    ) = ''
    AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
    AND pg_catalog.md5("function_row"."prosrc") =
      'd51c688124a37d0fe34bbabcc8568e97'
    AND "function_row"."proowner" = "table_row"."relowner"
    AND "language_row"."lanname" = 'plpgsql'
    AND NOT "function_row"."prosecdef"
    AND NOT "function_row"."proleakproof"
    AND NOT "function_row"."proisstrict"
    AND NOT "function_row"."proretset"
    AND "function_row"."provolatile" = 'v'
    AND "function_row"."proparallel" = 'u'
    AND "function_row"."proconfig" IS NULL;

  IF helper_trigger_oid IS NULL OR helper_function_oid IS NULL THEN
    RAISE EXCEPTION 'Entitlement contract requires the accepted org metadata helper identity';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgname" =
      'sync_org_plan_entitlement_model_restrictions_1023'
      AND NOT "tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_plan_entitlement_model_restrictions_1023'
  ) <> 1 THEN
    RAISE EXCEPTION 'Entitlement contract requires exactly one 1023 bridge trigger and function';
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
  WHERE "trigger_row"."tgrelid" = entitlement_oid
    AND "trigger_row"."tgname" =
      'sync_org_plan_entitlement_model_restrictions_1023'
    AND NOT "trigger_row"."tgisinternal"
    AND "trigger_row"."tgenabled" = 'O'
    AND NOT "trigger_row"."tgdeferrable"
    AND NOT "trigger_row"."tginitdeferred"
    AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
      'CREATE TRIGGER sync_org_plan_entitlement_model_restrictions_1023 BEFORE INSERT OR UPDATE OF restricted_vm0_models, restricted_built_in_models ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_org_plan_entitlement_model_restrictions_1023()'
    AND "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" =
      'sync_org_plan_entitlement_model_restrictions_1023'
    AND "function_row"."prokind" = 'f'
    AND pg_catalog.pg_get_function_identity_arguments(
      "function_row"."oid"
    ) = ''
    AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
    AND pg_catalog.md5("function_row"."prosrc") =
      'c46d67f828e6890bedef54daade5ce43'
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
    RAISE EXCEPTION 'Entitlement contract requires the accepted enabled 1023 bridge identity';
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
    AND "dependency_row"."refobjid" = entitlement_oid
    AND "dependency_row"."refobjsubid" IN (
      legacy_attnum,
      canonical_attnum
    )
    AND NOT (
      (
        "dependency_row"."classid" = 'pg_attrdef'::regclass
        AND "dependency_row"."objid" = legacy_default_oid
        AND "dependency_row"."refobjsubid" = legacy_attnum
      ) OR (
        "dependency_row"."classid" = 'pg_trigger'::regclass
        AND "dependency_row"."objid" = bridge_trigger_oid
      ) OR (
        "dependency_row"."classid" = 'pg_constraint'::regclass
        AND EXISTS (
          SELECT 1
          FROM "pg_catalog"."pg_constraint" AS "not_null_row"
          WHERE "not_null_row"."oid" = "dependency_row"."objid"
            AND "not_null_row"."conrelid" = entitlement_oid
            AND "not_null_row"."contype" = 'n'
            AND "not_null_row"."conkey" =
              ARRAY["dependency_row"."refobjsubid"]::smallint[]
        )
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Entitlement contract found unexpected restriction catalog dependencies: %', unexpected_objects;
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
  WHERE "definition" ~* '\mrestricted_vm0_models\M';

  IF routine_references IS DISTINCT FROM ARRAY[
    'public.ensure_legacy_org_metadata_plan_entitlement()',
    'public.sync_org_plan_entitlement_model_restrictions_1023()'
  ]::text[] THEN
    RAISE EXCEPTION 'Entitlement contract found unexpected routines referencing restricted_vm0_models: %', routine_references;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements" AS "entitlement_row"
    WHERE pg_catalog.jsonb_typeof(
        pg_catalog.to_jsonb("entitlement_row") -> 'restricted_vm0_models'
      ) = 'null'
      OR pg_catalog.jsonb_typeof(
        pg_catalog.to_jsonb("entitlement_row") -> 'restricted_built_in_models'
      ) = 'null'
  ) THEN
    RAISE EXCEPTION 'Entitlement contract found NULL model restriction data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    WHERE "restricted_vm0_models" IS DISTINCT FROM
      "restricted_built_in_models"
  ) THEN
    RAISE EXCEPTION 'Entitlement contract found unequal model restriction data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements" AS "entitlement_row"
    WHERE pg_catalog.jsonb_typeof(
      pg_catalog.to_jsonb("entitlement_row") -> 'org_id'
    ) = 'null'
  ) OR EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    GROUP BY "org_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Entitlement contract requires unique non-NULL org_id values';
  END IF;
END;
$$;--> statement-breakpoint

CREATE TEMP TABLE "org_plan_entitlement_contract_state_1041"
ON COMMIT DROP
AS
SELECT
  count(*)::bigint AS "row_count",
  pg_catalog.md5(
    COALESCE(
      jsonb_agg(
        jsonb_build_array("org_id", "restricted_built_in_models")
        ORDER BY "org_id"
      ),
      '[]'::jsonb
    )::text
  ) AS "canonical_fingerprint"
FROM "org_plan_entitlements";--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ensure_legacy_org_metadata_plan_entitlement()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY INVOKER
AS $$
BEGIN
	INSERT INTO "org_plan_entitlements" (
		"org_id",
		"plan_key",
		"plan_rank",
		"source",
		"status",
		"base_concurrency_limit",
		"can_buy_concurrency",
		"can_buy_credits",
		"auto_recharge_allowed",
		"support_byok",
		"restricted_built_in_models",
		"video_generation_allowed",
		"workflow_webhook_trigger_allowed",
		"audio_lifetime_limit",
		"audio_daily_rate_limit",
		"audio_daily_duration_seconds"
	)
	SELECT
		NEW."org_id",
		plans."plan_key",
		plans."plan_rank",
		'org_metadata_migration',
		plans."status",
		plans."base_concurrency_limit",
		plans."can_buy_concurrency",
		plans."can_buy_credits",
		plans."auto_recharge_allowed",
		plans."support_byok",
		plans."restricted_built_in_models",
		plans."video_generation_allowed",
		plans."workflow_webhook_trigger_allowed",
		plans."audio_lifetime_limit",
		plans."audio_daily_rate_limit",
		plans."audio_daily_duration_seconds"
	FROM (
		VALUES
			('free', 0, 'active', 1, false, true, false, true, false, true, false, 10, 10, 600),
			('limited-free-1', 0, 'active', 1, false, false, false, false, true, false, false, 10, 10, 600),
			('pro-suspend', 0, 'suspended', 0, false, false, false, false, true, false, false, 0, 0, 0),
			('pro', 1, 'active', 2, false, true, true, true, false, true, false, NULL, 300, 12000),
			('team', 2, 'active', 10, true, true, true, true, false, true, true, NULL, 500, 30000),
			('custom', 3, 'active', 10, true, true, true, true, false, true, true, NULL, 500, 30000)
	) AS plans(
		"plan_key",
		"plan_rank",
		"status",
		"base_concurrency_limit",
		"can_buy_concurrency",
		"can_buy_credits",
		"auto_recharge_allowed",
		"support_byok",
		"restricted_built_in_models",
		"video_generation_allowed",
		"workflow_webhook_trigger_allowed",
		"audio_lifetime_limit",
		"audio_daily_rate_limit",
		"audio_daily_duration_seconds"
	)
	WHERE plans."plan_key" = NEW."tier"
	ON CONFLICT ("org_id") DO NOTHING;
	RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"
ON "org_plan_entitlements";--> statement-breakpoint

DROP FUNCTION public."sync_org_plan_entitlement_model_restrictions_1023"();--> statement-breakpoint

ALTER TABLE "org_plan_entitlements"
DROP COLUMN "restricted_vm0_models";--> statement-breakpoint

DO $$
DECLARE
  org_metadata_oid oid;
  entitlement_oid oid;
  org_id_attnum smallint;
  canonical_attnum smallint;
  primary_constraint_oid oid;
  helper_trigger_oid oid;
  helper_function_oid oid;
  restriction_columns jsonb;
  unexpected_objects text[];
  routine_references text[];
  before_row_count bigint;
  after_row_count bigint;
  before_fingerprint text;
  after_fingerprint text;
BEGIN
  SELECT "relation_row"."oid"
  INTO org_metadata_oid
  FROM "pg_catalog"."pg_class" AS "relation_row"
  INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
    ON "namespace_row"."oid" = "relation_row"."relnamespace"
  WHERE "namespace_row"."nspname" = 'public'
    AND "relation_row"."relname" = 'org_metadata'
    AND "relation_row"."relkind" = 'r'
    AND "relation_row"."relpersistence" = 'p';

  SELECT "relation_row"."oid"
  INTO entitlement_oid
  FROM "pg_catalog"."pg_class" AS "relation_row"
  INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
    ON "namespace_row"."oid" = "relation_row"."relnamespace"
  WHERE "namespace_row"."nspname" = 'public'
    AND "relation_row"."relname" = 'org_plan_entitlements'
    AND "relation_row"."relkind" = 'r'
    AND "relation_row"."relpersistence" = 'p';

  IF org_metadata_oid IS NULL OR entitlement_oid IS NULL THEN
    RAISE EXCEPTION 'Entitlement contract postcondition lost a required table';
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
  INTO restriction_columns
  FROM "pg_catalog"."pg_attribute" AS "attribute_row"
  LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
    ON "default_row"."adrelid" = "attribute_row"."attrelid"
    AND "default_row"."adnum" = "attribute_row"."attnum"
  WHERE "attribute_row"."attrelid" = entitlement_oid
    AND "attribute_row"."attname" IN (
      'org_id',
      'restricted_vm0_models',
      'restricted_built_in_models'
    )
    AND "attribute_row"."attnum" > 0
    AND NOT "attribute_row"."attisdropped";

  IF restriction_columns IS DISTINCT FROM jsonb_build_object(
    'org_id', jsonb_build_object(
      'type', 'text',
      'notNull', true,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'restricted_built_in_models', jsonb_build_object(
      'type', 'boolean',
      'notNull', true,
      'hasDefault', false,
      'default', NULL,
      'identity', '',
      'generated', '',
      'hasMissing', false
    )
  ) THEN
    RAISE EXCEPTION 'Entitlement contract postcondition found unexpected restriction columns: %', restriction_columns;
  END IF;

  SELECT "attnum"
  INTO org_id_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = entitlement_oid
    AND "attname" = 'org_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO canonical_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = entitlement_oid
    AND "attname" = 'restricted_built_in_models'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "constraint_row"."oid"
  INTO primary_constraint_oid
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  INNER JOIN "pg_catalog"."pg_index" AS "index_row"
    ON "index_row"."indexrelid" = "constraint_row"."conindid"
  WHERE "constraint_row"."conrelid" = entitlement_oid
    AND "constraint_row"."conname" = 'org_plan_entitlements_pkey'
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
    AND "index_row"."indrelid" = entitlement_oid
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
      'CREATE UNIQUE INDEX org_plan_entitlements_pkey ON public.org_plan_entitlements USING btree (org_id)';

  IF primary_constraint_oid IS NULL OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_constraint"
    WHERE "conrelid" = entitlement_oid
      AND "contype" = 'p'
  ) <> 1 THEN
    RAISE EXCEPTION 'Entitlement contract postcondition lost the exact org_id primary key';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgname" =
      'sync_org_plan_entitlement_model_restrictions_1023'
      AND NOT "tgisinternal"
  ) OR EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_plan_entitlement_model_restrictions_1023'
  ) THEN
    RAISE EXCEPTION 'Entitlement contract postcondition retained the 1023 bridge';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgname" = 'ensure_legacy_org_metadata_plan_entitlement'
      AND NOT "tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'ensure_legacy_org_metadata_plan_entitlement'
  ) <> 1 THEN
    RAISE EXCEPTION 'Entitlement contract postcondition lost the org metadata helper';
  END IF;

  SELECT "trigger_row"."oid", "function_row"."oid"
  INTO helper_trigger_oid, helper_function_oid
  FROM "pg_catalog"."pg_trigger" AS "trigger_row"
  INNER JOIN "pg_catalog"."pg_class" AS "table_row"
    ON "table_row"."oid" = "trigger_row"."tgrelid"
  INNER JOIN "pg_catalog"."pg_proc" AS "function_row"
    ON "function_row"."oid" = "trigger_row"."tgfoid"
  INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
    ON "function_namespace"."oid" = "function_row"."pronamespace"
  INNER JOIN "pg_catalog"."pg_language" AS "language_row"
    ON "language_row"."oid" = "function_row"."prolang"
  WHERE "trigger_row"."tgrelid" = org_metadata_oid
    AND "trigger_row"."tgname" =
      'ensure_legacy_org_metadata_plan_entitlement'
    AND NOT "trigger_row"."tgisinternal"
    AND "trigger_row"."tgenabled" = 'O'
    AND NOT "trigger_row"."tgdeferrable"
    AND NOT "trigger_row"."tginitdeferred"
    AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
      'CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()'
    AND "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" =
      'ensure_legacy_org_metadata_plan_entitlement'
    AND "function_row"."prokind" = 'f'
    AND pg_catalog.pg_get_function_identity_arguments(
      "function_row"."oid"
    ) = ''
    AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
    AND pg_catalog.md5("function_row"."prosrc") =
      '0b0d44031a51ffc349f0f33cb0df53c3'
    AND "function_row"."proowner" = "table_row"."relowner"
    AND "language_row"."lanname" = 'plpgsql'
    AND NOT "function_row"."prosecdef"
    AND NOT "function_row"."proleakproof"
    AND NOT "function_row"."proisstrict"
    AND NOT "function_row"."proretset"
    AND "function_row"."provolatile" = 'v'
    AND "function_row"."proparallel" = 'u'
    AND "function_row"."proconfig" IS NULL
    AND "function_row"."prosrc" !~* '\mrestricted_vm0_models\M'
    AND "function_row"."prosrc" ~* '\mrestricted_built_in_models\M'
    AND "function_row"."prosrc" ~
      'ON CONFLICT \("org_id"\) DO NOTHING';

  IF helper_trigger_oid IS NULL OR helper_function_oid IS NULL THEN
    RAISE EXCEPTION 'Entitlement contract postcondition found an unexpected canonical helper identity';
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
    AND "dependency_row"."refobjid" = entitlement_oid
    AND "dependency_row"."refobjsubid" = canonical_attnum
    AND NOT (
      "dependency_row"."classid" = 'pg_constraint'::regclass
      AND EXISTS (
        SELECT 1
        FROM "pg_catalog"."pg_constraint" AS "not_null_row"
        WHERE "not_null_row"."oid" = "dependency_row"."objid"
          AND "not_null_row"."conrelid" = entitlement_oid
          AND "not_null_row"."contype" = 'n'
          AND "not_null_row"."conkey" =
            ARRAY[canonical_attnum]::smallint[]
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Entitlement contract postcondition found unexpected canonical dependencies: %', unexpected_objects;
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
  WHERE "definition" ~* '\mrestricted_vm0_models\M';

  IF routine_references IS NOT NULL THEN
    RAISE EXCEPTION 'Entitlement contract postcondition retained routines referencing restricted_vm0_models: %', routine_references;
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
  WHERE "definition" ~* '\mrestricted_built_in_models\M';

  IF routine_references IS DISTINCT FROM ARRAY[
    'public.ensure_legacy_org_metadata_plan_entitlement()'
  ]::text[] THEN
    RAISE EXCEPTION 'Entitlement contract postcondition found unexpected canonical routine references: %', routine_references;
  END IF;

  SELECT "row_count", "canonical_fingerprint"
  INTO before_row_count, before_fingerprint
  FROM "org_plan_entitlement_contract_state_1041";

  SELECT
    count(*)::bigint,
    pg_catalog.md5(
      COALESCE(
        jsonb_agg(
          jsonb_build_array("org_id", "restricted_built_in_models")
          ORDER BY "org_id"
        ),
        '[]'::jsonb
      )::text
    )
  INTO after_row_count, after_fingerprint
  FROM "org_plan_entitlements";

  IF before_row_count IS DISTINCT FROM after_row_count
    OR before_fingerprint IS DISTINCT FROM after_fingerprint
  THEN
    RAISE EXCEPTION 'Entitlement contract did not preserve the canonical row set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_plan_entitlements" AS "entitlement_row"
    WHERE pg_catalog.jsonb_typeof(
      pg_catalog.to_jsonb("entitlement_row") -> 'restricted_built_in_models'
    ) = 'null'
  ) OR EXISTS (
    SELECT 1
    FROM "org_plan_entitlements"
    GROUP BY "org_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Entitlement contract postcondition violated canonical row invariants';
  END IF;
END;
$$;
