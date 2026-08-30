SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Verify the complete pre-contract catalog before touching data. The bridge
-- and metadata check are the only allowed dependencies on the legacy column.
DO $$
DECLARE
  agent_runs_oid oid;
  legacy_attnum smallint;
  canonical_attnum smallint;
  model_key_columns jsonb;
  metadata_constraint_oid oid;
  metadata_definition text;
  metadata_columns text[];
  bridge_trigger_oid oid;
  bridge_function_oid oid;
  unexpected_objects text[];
  routine_references text[];
BEGIN
  SELECT "table_row"."oid"
  INTO agent_runs_oid
  FROM "pg_catalog"."pg_class" AS "table_row"
  INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
    ON "namespace_row"."oid" = "table_row"."relnamespace"
  WHERE "namespace_row"."nspname" = 'public'
    AND "table_row"."relname" = 'agent_runs'
    AND "table_row"."relkind" = 'r'
    AND "table_row"."relpersistence" = 'p';

  IF agent_runs_oid IS NULL THEN
    RAISE EXCEPTION 'Agent Run model key contract requires public.agent_runs to be an ordinary permanent table';
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
      'identity', "attribute_row"."attidentity",
      'generated', "attribute_row"."attgenerated",
      'hasMissing', "attribute_row"."atthasmissing"
    )
  )
  INTO model_key_columns
  FROM "pg_catalog"."pg_attribute" AS "attribute_row"
  WHERE "attribute_row"."attrelid" = agent_runs_oid
    AND "attribute_row"."attname" IN (
      'vm0_model_key_id',
      'built_in_model_key_id'
    )
    AND "attribute_row"."attnum" > 0
    AND NOT "attribute_row"."attisdropped";

  IF model_key_columns IS DISTINCT FROM jsonb_build_object(
    'vm0_model_key_id', jsonb_build_object(
      'type', 'uuid',
      'notNull', false,
      'hasDefault', false,
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'built_in_model_key_id', jsonb_build_object(
      'type', 'uuid',
      'notNull', false,
      'hasDefault', false,
      'identity', '',
      'generated', '',
      'hasMissing', false
    )
  ) THEN
    RAISE EXCEPTION 'Unexpected Agent Run model key column catalog: %', model_key_columns;
  END IF;

  SELECT "attnum"
  INTO legacy_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = agent_runs_oid
    AND "attname" = 'vm0_model_key_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO canonical_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = agent_runs_oid
    AND "attname" = 'built_in_model_key_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT
    "constraint_row"."oid",
    pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
  INTO metadata_constraint_oid, metadata_definition
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  WHERE "constraint_row"."conrelid" = agent_runs_oid
    AND "constraint_row"."conname" = 'agent_runs_metadata_presence_check'
    AND "constraint_row"."contype" = 'c'
    AND "constraint_row"."convalidated"
    AND NOT "constraint_row"."condeferrable"
    AND NOT "constraint_row"."condeferred"
    AND "constraint_row"."conislocal"
    AND "constraint_row"."coninhcount" = 0
    AND NOT "constraint_row"."connoinherit";

  IF metadata_constraint_oid IS NULL THEN
    RAISE EXCEPTION 'Agent Run model key contract requires the exact validated metadata-presence check';
  END IF;

  SELECT array_agg("attribute_row"."attname" ORDER BY "attribute_row"."attname")
  INTO metadata_columns
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  CROSS JOIN LATERAL unnest("constraint_row"."conkey") AS "key_row"("attnum")
  INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
    ON "attribute_row"."attrelid" = "constraint_row"."conrelid"
    AND "attribute_row"."attnum" = "key_row"."attnum"
  WHERE "constraint_row"."oid" = metadata_constraint_oid;

  IF metadata_columns IS DISTINCT FROM ARRAY[
    'api_started_at',
    'autonomy_budget',
    'built_in_model_key_id',
    'chat_thread_id',
    'codex_service_tier',
    'first_assistant_event_acknowledged_at',
    'goal_id',
    'model_provider',
    'model_provider_credential_scope',
    'model_provider_id',
    'model_runtime_model',
    'model_runtime_provider',
    'selected_image_model',
    'selected_model',
    'selected_video_model',
    'summary',
    'trigger_brief',
    'trigger_source',
    'vm0_model_key_id',
    'workflow_automation_id'
  ]::text[]
    OR pg_catalog.md5(metadata_definition) <>
      '38d10fdf70fe2d82967eb606c9283e4f'
    OR pg_catalog.regexp_count(metadata_definition, ' IS NULL') <> 20
    OR pg_catalog.regexp_count(metadata_definition, ' IS NOT NULL') <> 2
    OR position('vm0_model_key_id IS NULL' IN metadata_definition) = 0
    OR position('built_in_model_key_id IS NULL' IN metadata_definition) = 0
    OR position('trigger_source IS NOT NULL' IN metadata_definition) = 0
    OR position('autonomy_budget IS NOT NULL' IN metadata_definition) = 0
  THEN
    RAISE EXCEPTION
      'Unexpected Agent Run metadata-presence check: columns=%, definition=%',
      metadata_columns,
      metadata_definition;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_constraint"
    WHERE "conrelid" = agent_runs_oid
      AND "conname" = 'agent_runs_metadata_presence_check_0976'
  ) THEN
    RAISE EXCEPTION 'Agent Run model key contract staging constraint already exists';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgrelid" = agent_runs_oid
      AND "tgname" = 'sync_agent_run_model_key_ids_0971'
      AND NOT "tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" = 'sync_agent_run_model_key_ids_0971'
  ) <> 1 THEN
    RAISE EXCEPTION 'Agent Run model key contract requires exactly one 0971 trigger and function';
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
  WHERE "trigger_row"."tgrelid" = agent_runs_oid
    AND "trigger_row"."tgname" = 'sync_agent_run_model_key_ids_0971'
    AND NOT "trigger_row"."tgisinternal"
    AND "trigger_row"."tgenabled" = 'O'
    AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
      'CREATE TRIGGER sync_agent_run_model_key_ids_0971 BEFORE INSERT OR UPDATE OF vm0_model_key_id, built_in_model_key_id ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION sync_agent_run_model_key_ids_0971()'
    AND "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" = 'sync_agent_run_model_key_ids_0971'
    AND "function_row"."prokind" = 'f'
    AND pg_catalog.pg_get_function_identity_arguments("function_row"."oid") = ''
    AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
    AND pg_catalog.md5("function_row"."prosrc") = '0cb34f89e8724080310d14f837a3b762'
    AND "function_row"."proowner" = "table_row"."relowner"
    AND "language_row"."lanname" = 'plpgsql'
    AND NOT "function_row"."prosecdef"
    AND NOT "function_row"."proisstrict"
    AND "function_row"."provolatile" = 'v'
    AND "function_row"."proparallel" = 'u';

  IF bridge_trigger_oid IS NULL OR bridge_function_oid IS NULL THEN
    RAISE EXCEPTION 'Agent Run model key contract requires the accepted enabled 0971 bridge identity';
  END IF;

  SELECT array_agg("index_row"."relname" ORDER BY "index_row"."relname")
  INTO unexpected_objects
  FROM "pg_catalog"."pg_index" AS "index_catalog"
  INNER JOIN "pg_catalog"."pg_class" AS "index_row"
    ON "index_row"."oid" = "index_catalog"."indexrelid"
  WHERE "index_catalog"."indrelid" = agent_runs_oid
    AND (
      legacy_attnum = ANY("index_catalog"."indkey"::smallint[])
      OR canonical_attnum = ANY("index_catalog"."indkey"::smallint[])
      OR EXISTS (
        SELECT 1
        FROM "pg_catalog"."pg_depend" AS "dependency_row"
        WHERE "dependency_row"."classid" = 'pg_class'::regclass
          AND "dependency_row"."objid" = "index_catalog"."indexrelid"
          AND "dependency_row"."refclassid" = 'pg_class'::regclass
          AND "dependency_row"."refobjid" = agent_runs_oid
          AND "dependency_row"."refobjsubid" IN (
            legacy_attnum,
            canonical_attnum
          )
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Agent Run model key columns have unexpected indexes: %', unexpected_objects;
  END IF;

  SELECT array_agg(
    pg_catalog.pg_describe_object(
      'pg_constraint'::regclass,
      "constraint_row"."oid",
      0
    )
    ORDER BY "constraint_row"."oid"
  )
  INTO unexpected_objects
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  WHERE "constraint_row"."contype" = 'f'
    AND (
      (
        "constraint_row"."conrelid" = agent_runs_oid
        AND (
          legacy_attnum = ANY("constraint_row"."conkey")
          OR canonical_attnum = ANY("constraint_row"."conkey")
        )
      ) OR (
        "constraint_row"."confrelid" = agent_runs_oid
        AND (
          legacy_attnum = ANY("constraint_row"."confkey")
          OR canonical_attnum = ANY("constraint_row"."confkey")
        )
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Agent Run model key columns have unexpected foreign keys: %', unexpected_objects;
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
    AND "dependency_row"."refobjid" = agent_runs_oid
    AND "dependency_row"."refobjsubid" = legacy_attnum
    AND NOT (
      (
        "dependency_row"."classid" = 'pg_constraint'::regclass
        AND "dependency_row"."objid" = metadata_constraint_oid
      ) OR (
        "dependency_row"."classid" = 'pg_trigger'::regclass
        AND "dependency_row"."objid" = bridge_trigger_oid
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Agent Run legacy model key column has unexpected catalog dependencies: %', unexpected_objects;
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
  WHERE "definition" ~* '\mvm0_model_key_id\M';

  IF routine_references IS DISTINCT FROM ARRAY[
    'public.sync_agent_run_model_key_ids_0971()'
  ]::text[] THEN
    RAISE EXCEPTION 'Unexpected stored routines reference vm0_model_key_id: %', routine_references;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "vm0_model_key_id" IS NULL
      AND "built_in_model_key_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Agent Run model key contract found canonical-only rows before backfill';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "vm0_model_key_id" IS NOT NULL
      AND "built_in_model_key_id" IS NOT NULL
      AND "vm0_model_key_id" IS DISTINCT FROM "built_in_model_key_id"
  ) THEN
    RAISE EXCEPTION 'Agent Run model key contract found unequal dual rows before backfill';
  END IF;
END;
$$;--> statement-breakpoint

-- Final idempotent legacy-only backfill. The exact 0971 trigger remains
-- enabled, so this update also preserves the accepted equality invariant.
UPDATE "agent_runs"
SET "built_in_model_key_id" = "vm0_model_key_id"
WHERE "vm0_model_key_id" IS NOT NULL
  AND "built_in_model_key_id" IS NULL;--> statement-breakpoint

-- Begin the bounded final section only after preflight and backfill. The
-- remaining work is the final parity/catalog check plus metadata-only contract
-- DDL; the statement timeout also bounds validation of the replacement check.
LOCK TABLE "agent_runs" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

ALTER TABLE "agent_runs"
ADD CONSTRAINT "agent_runs_metadata_presence_check_0976" CHECK ((
          (
            "agent_runs"."trigger_source" IS NULL AND
            "agent_runs"."autonomy_budget" IS NULL AND
            "agent_runs"."workflow_automation_id" IS NULL AND
            "agent_runs"."goal_id" IS NULL AND
            "agent_runs"."model_provider" IS NULL AND
            "agent_runs"."model_provider_id" IS NULL AND
            "agent_runs"."model_provider_credential_scope" IS NULL AND
            "agent_runs"."selected_model" IS NULL AND
            "agent_runs"."model_runtime_provider" IS NULL AND
            "agent_runs"."model_runtime_model" IS NULL AND
            "agent_runs"."built_in_model_key_id" IS NULL AND
            "agent_runs"."codex_service_tier" IS NULL AND
            "agent_runs"."selected_video_model" IS NULL AND
            "agent_runs"."selected_image_model" IS NULL AND
            "agent_runs"."chat_thread_id" IS NULL AND
            "agent_runs"."api_started_at" IS NULL AND
            "agent_runs"."first_assistant_event_acknowledged_at" IS NULL AND
            "agent_runs"."summary" IS NULL AND
            "agent_runs"."trigger_brief" IS NULL
          ) OR (
            "agent_runs"."trigger_source" IS NOT NULL AND
            "agent_runs"."autonomy_budget" IS NOT NULL
          )
        )) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_metadata_presence_check_0976";--> statement-breakpoint

DO $$
DECLARE
  agent_runs_oid oid := 'public.agent_runs'::regclass;
  legacy_attnum smallint;
  canonical_attnum smallint;
  model_key_columns jsonb;
  metadata_constraint_oid oid;
  metadata_definition text;
  metadata_columns text[];
  staged_constraint_oid oid;
  staged_definition text;
  staged_columns text[];
  bridge_trigger_oid oid;
  bridge_function_oid oid;
  unexpected_objects text[];
  routine_references text[];
  legacy_only_count bigint;
  canonical_only_count bigint;
  unequal_dual_count bigint;
  canonical_fingerprint text;
BEGIN
  SELECT jsonb_object_agg(
    "attribute_row"."attname",
    jsonb_build_object(
      'type', pg_catalog.format_type(
        "attribute_row"."atttypid",
        "attribute_row"."atttypmod"
      ),
      'notNull', "attribute_row"."attnotnull",
      'hasDefault', "attribute_row"."atthasdef",
      'identity', "attribute_row"."attidentity",
      'generated', "attribute_row"."attgenerated",
      'hasMissing', "attribute_row"."atthasmissing"
    )
  )
  INTO model_key_columns
  FROM "pg_catalog"."pg_attribute" AS "attribute_row"
  WHERE "attribute_row"."attrelid" = agent_runs_oid
    AND "attribute_row"."attname" IN (
      'vm0_model_key_id',
      'built_in_model_key_id'
    )
    AND "attribute_row"."attnum" > 0
    AND NOT "attribute_row"."attisdropped";

  IF model_key_columns IS DISTINCT FROM jsonb_build_object(
    'vm0_model_key_id', jsonb_build_object(
      'type', 'uuid',
      'notNull', false,
      'hasDefault', false,
      'identity', '',
      'generated', '',
      'hasMissing', false
    ),
    'built_in_model_key_id', jsonb_build_object(
      'type', 'uuid',
      'notNull', false,
      'hasDefault', false,
      'identity', '',
      'generated', '',
      'hasMissing', false
    )
  ) THEN
    RAISE EXCEPTION 'Final Agent Run model key catalog gate found unexpected columns: %', model_key_columns;
  END IF;

  SELECT "attnum"
  INTO legacy_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = agent_runs_oid
    AND "attname" = 'vm0_model_key_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT "attnum"
  INTO canonical_attnum
  FROM "pg_catalog"."pg_attribute"
  WHERE "attrelid" = agent_runs_oid
    AND "attname" = 'built_in_model_key_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  SELECT
    "constraint_row"."oid",
    pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
  INTO metadata_constraint_oid, metadata_definition
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  WHERE "constraint_row"."conrelid" = agent_runs_oid
    AND "constraint_row"."conname" = 'agent_runs_metadata_presence_check'
    AND "constraint_row"."contype" = 'c'
    AND "constraint_row"."convalidated"
    AND NOT "constraint_row"."condeferrable"
    AND NOT "constraint_row"."condeferred"
    AND "constraint_row"."conislocal"
    AND "constraint_row"."coninhcount" = 0
    AND NOT "constraint_row"."connoinherit";

  SELECT array_agg("attribute_row"."attname" ORDER BY "attribute_row"."attname")
  INTO metadata_columns
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  CROSS JOIN LATERAL unnest("constraint_row"."conkey") AS "key_row"("attnum")
  INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
    ON "attribute_row"."attrelid" = "constraint_row"."conrelid"
    AND "attribute_row"."attnum" = "key_row"."attnum"
  WHERE "constraint_row"."oid" = metadata_constraint_oid;

  IF metadata_constraint_oid IS NULL
    OR metadata_columns IS DISTINCT FROM ARRAY[
      'api_started_at',
      'autonomy_budget',
      'built_in_model_key_id',
      'chat_thread_id',
      'codex_service_tier',
      'first_assistant_event_acknowledged_at',
      'goal_id',
      'model_provider',
      'model_provider_credential_scope',
      'model_provider_id',
      'model_runtime_model',
      'model_runtime_provider',
      'selected_image_model',
      'selected_model',
      'selected_video_model',
      'summary',
      'trigger_brief',
      'trigger_source',
      'vm0_model_key_id',
      'workflow_automation_id'
    ]::text[]
    OR pg_catalog.md5(metadata_definition) <>
      '38d10fdf70fe2d82967eb606c9283e4f'
    OR pg_catalog.regexp_count(metadata_definition, ' IS NULL') <> 20
    OR pg_catalog.regexp_count(metadata_definition, ' IS NOT NULL') <> 2
    OR position('vm0_model_key_id IS NULL' IN metadata_definition) = 0
    OR position('built_in_model_key_id IS NULL' IN metadata_definition) = 0
  THEN
    RAISE EXCEPTION
      'Final Agent Run model key catalog gate found unexpected legacy metadata check: columns=%, definition=%',
      metadata_columns,
      metadata_definition;
  END IF;

  SELECT
    "constraint_row"."oid",
    pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
  INTO staged_constraint_oid, staged_definition
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  WHERE "constraint_row"."conrelid" = agent_runs_oid
    AND "constraint_row"."conname" = 'agent_runs_metadata_presence_check_0976'
    AND "constraint_row"."contype" = 'c'
    AND "constraint_row"."convalidated"
    AND NOT "constraint_row"."condeferrable"
    AND NOT "constraint_row"."condeferred"
    AND "constraint_row"."conislocal"
    AND "constraint_row"."coninhcount" = 0
    AND NOT "constraint_row"."connoinherit";

  SELECT array_agg("attribute_row"."attname" ORDER BY "attribute_row"."attname")
  INTO staged_columns
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  CROSS JOIN LATERAL unnest("constraint_row"."conkey") AS "key_row"("attnum")
  INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
    ON "attribute_row"."attrelid" = "constraint_row"."conrelid"
    AND "attribute_row"."attnum" = "key_row"."attnum"
  WHERE "constraint_row"."oid" = staged_constraint_oid;

  IF staged_constraint_oid IS NULL
    OR staged_columns IS DISTINCT FROM ARRAY[
      'api_started_at',
      'autonomy_budget',
      'built_in_model_key_id',
      'chat_thread_id',
      'codex_service_tier',
      'first_assistant_event_acknowledged_at',
      'goal_id',
      'model_provider',
      'model_provider_credential_scope',
      'model_provider_id',
      'model_runtime_model',
      'model_runtime_provider',
      'selected_image_model',
      'selected_model',
      'selected_video_model',
      'summary',
      'trigger_brief',
      'trigger_source',
      'workflow_automation_id'
    ]::text[]
    OR pg_catalog.md5(staged_definition) <>
      '20ee7ec050f6cd8c9559505d3e7ce2a6'
    OR pg_catalog.regexp_count(staged_definition, ' IS NULL') <> 19
    OR pg_catalog.regexp_count(staged_definition, ' IS NOT NULL') <> 2
    OR staged_definition ~* '\mvm0_model_key_id\M'
    OR position('built_in_model_key_id IS NULL' IN staged_definition) = 0
    OR position('trigger_source IS NOT NULL' IN staged_definition) = 0
    OR position('autonomy_budget IS NOT NULL' IN staged_definition) = 0
  THEN
    RAISE EXCEPTION
      'Final Agent Run model key catalog gate found unexpected canonical metadata check: columns=%, definition=%',
      staged_columns,
      staged_definition;
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgrelid" = agent_runs_oid
      AND "tgname" = 'sync_agent_run_model_key_ids_0971'
      AND NOT "tgisinternal"
  ) <> 1 OR (
    SELECT count(*)
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" = 'sync_agent_run_model_key_ids_0971'
  ) <> 1 THEN
    RAISE EXCEPTION 'Final Agent Run model key catalog gate requires exactly one 0971 trigger and function';
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
  WHERE "trigger_row"."tgrelid" = agent_runs_oid
    AND "trigger_row"."tgname" = 'sync_agent_run_model_key_ids_0971'
    AND NOT "trigger_row"."tgisinternal"
    AND "trigger_row"."tgenabled" = 'O'
    AND pg_catalog.pg_get_triggerdef("trigger_row"."oid") =
      'CREATE TRIGGER sync_agent_run_model_key_ids_0971 BEFORE INSERT OR UPDATE OF vm0_model_key_id, built_in_model_key_id ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION sync_agent_run_model_key_ids_0971()'
    AND "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" = 'sync_agent_run_model_key_ids_0971'
    AND "function_row"."prokind" = 'f'
    AND pg_catalog.pg_get_function_identity_arguments("function_row"."oid") = ''
    AND pg_catalog.pg_get_function_result("function_row"."oid") = 'trigger'
    AND pg_catalog.md5("function_row"."prosrc") = '0cb34f89e8724080310d14f837a3b762'
    AND "function_row"."proowner" = "table_row"."relowner"
    AND "language_row"."lanname" = 'plpgsql'
    AND NOT "function_row"."prosecdef"
    AND NOT "function_row"."proisstrict"
    AND "function_row"."provolatile" = 'v'
    AND "function_row"."proparallel" = 'u';

  IF bridge_trigger_oid IS NULL OR bridge_function_oid IS NULL THEN
    RAISE EXCEPTION 'Final Agent Run model key catalog gate requires the exact enabled 0971 bridge';
  END IF;

  SELECT array_agg("index_row"."relname" ORDER BY "index_row"."relname")
  INTO unexpected_objects
  FROM "pg_catalog"."pg_index" AS "index_catalog"
  INNER JOIN "pg_catalog"."pg_class" AS "index_row"
    ON "index_row"."oid" = "index_catalog"."indexrelid"
  WHERE "index_catalog"."indrelid" = agent_runs_oid
    AND (
      legacy_attnum = ANY("index_catalog"."indkey"::smallint[])
      OR canonical_attnum = ANY("index_catalog"."indkey"::smallint[])
      OR EXISTS (
        SELECT 1
        FROM "pg_catalog"."pg_depend" AS "dependency_row"
        WHERE "dependency_row"."classid" = 'pg_class'::regclass
          AND "dependency_row"."objid" = "index_catalog"."indexrelid"
          AND "dependency_row"."refclassid" = 'pg_class'::regclass
          AND "dependency_row"."refobjid" = agent_runs_oid
          AND "dependency_row"."refobjsubid" IN (
            legacy_attnum,
            canonical_attnum
          )
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Final Agent Run model key catalog gate found unexpected indexes: %', unexpected_objects;
  END IF;

  SELECT array_agg(
    pg_catalog.pg_describe_object(
      'pg_constraint'::regclass,
      "constraint_row"."oid",
      0
    )
    ORDER BY "constraint_row"."oid"
  )
  INTO unexpected_objects
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  WHERE "constraint_row"."contype" = 'f'
    AND (
      (
        "constraint_row"."conrelid" = agent_runs_oid
        AND (
          legacy_attnum = ANY("constraint_row"."conkey")
          OR canonical_attnum = ANY("constraint_row"."conkey")
        )
      ) OR (
        "constraint_row"."confrelid" = agent_runs_oid
        AND (
          legacy_attnum = ANY("constraint_row"."confkey")
          OR canonical_attnum = ANY("constraint_row"."confkey")
        )
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Final Agent Run model key catalog gate found unexpected foreign keys: %', unexpected_objects;
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
    AND "dependency_row"."refobjid" = agent_runs_oid
    AND "dependency_row"."refobjsubid" = legacy_attnum
    AND NOT (
      (
        "dependency_row"."classid" = 'pg_constraint'::regclass
        AND "dependency_row"."objid" = metadata_constraint_oid
      ) OR (
        "dependency_row"."classid" = 'pg_trigger'::regclass
        AND "dependency_row"."objid" = bridge_trigger_oid
      )
    );

  IF unexpected_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Final Agent Run model key catalog gate found unexpected legacy dependencies: %', unexpected_objects;
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
  WHERE "definition" ~* '\mvm0_model_key_id\M';

  IF routine_references IS DISTINCT FROM ARRAY[
    'public.sync_agent_run_model_key_ids_0971()'
  ]::text[] THEN
    RAISE EXCEPTION 'Final Agent Run model key catalog gate found unexpected routine references: %', routine_references;
  END IF;

  SELECT
    count(*) FILTER (
      WHERE "vm0_model_key_id" IS NOT NULL
        AND "built_in_model_key_id" IS NULL
    ),
    count(*) FILTER (
      WHERE "vm0_model_key_id" IS NULL
        AND "built_in_model_key_id" IS NOT NULL
    ),
    count(*) FILTER (
      WHERE "vm0_model_key_id" IS NOT NULL
        AND "built_in_model_key_id" IS NOT NULL
        AND "vm0_model_key_id" IS DISTINCT FROM "built_in_model_key_id"
    )
  INTO legacy_only_count, canonical_only_count, unequal_dual_count
  FROM "agent_runs";

  IF legacy_only_count <> 0
    OR canonical_only_count <> 0
    OR unequal_dual_count <> 0
  THEN
    RAISE EXCEPTION
      'Final Agent Run model key parity failed: legacy-only=%, canonical-only=%, unequal=%',
      legacy_only_count,
      canonical_only_count,
      unequal_dual_count;
  END IF;

  SELECT jsonb_build_object(
    'rowCount', count(*),
    'nonNullCount', count("built_in_model_key_id"),
    'nonNullHash', CASE
      WHEN count("built_in_model_key_id") = 0 THEN NULL
      ELSE pg_catalog.md5(
        string_agg(
          "id"::text || ':' || "built_in_model_key_id"::text,
          ',' ORDER BY "id"
        ) FILTER (WHERE "built_in_model_key_id" IS NOT NULL)
      )
    END
  )::text
  INTO canonical_fingerprint
  FROM "agent_runs";

  PERFORM pg_catalog.set_config(
    'vm0.agent_run_model_key_contract_fingerprint',
    canonical_fingerprint,
    true
  );
END;
$$;--> statement-breakpoint

DROP TRIGGER "sync_agent_run_model_key_ids_0971" ON "agent_runs";--> statement-breakpoint
DROP FUNCTION "sync_agent_run_model_key_ids_0971"();--> statement-breakpoint
ALTER TABLE "agent_runs"
DROP CONSTRAINT "agent_runs_metadata_presence_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "vm0_model_key_id";--> statement-breakpoint
ALTER TABLE "agent_runs"
RENAME CONSTRAINT "agent_runs_metadata_presence_check_0976"
TO "agent_runs_metadata_presence_check";--> statement-breakpoint

DO $$
DECLARE
  agent_runs_oid oid := 'public.agent_runs'::regclass;
  canonical_attnum smallint;
  canonical_catalog jsonb;
  metadata_constraint_oid oid;
  metadata_definition text;
  metadata_columns text[];
  residual_catalog_objects text[];
  canonical_fingerprint text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_attribute"
    WHERE "attrelid" = agent_runs_oid
      AND "attname" = 'vm0_model_key_id'
      AND "attnum" > 0
      AND NOT "attisdropped"
  ) THEN
    RAISE EXCEPTION 'Agent Run legacy model key column remains after contract';
  END IF;

  SELECT
    "attribute_row"."attnum",
    jsonb_build_object(
      'type', pg_catalog.format_type(
        "attribute_row"."atttypid",
        "attribute_row"."atttypmod"
      ),
      'notNull', "attribute_row"."attnotnull",
      'hasDefault', "attribute_row"."atthasdef",
      'identity', "attribute_row"."attidentity",
      'generated', "attribute_row"."attgenerated",
      'hasMissing', "attribute_row"."atthasmissing"
    )
  INTO canonical_attnum, canonical_catalog
  FROM "pg_catalog"."pg_attribute" AS "attribute_row"
  WHERE "attribute_row"."attrelid" = agent_runs_oid
    AND "attribute_row"."attname" = 'built_in_model_key_id'
    AND "attribute_row"."attnum" > 0
    AND NOT "attribute_row"."attisdropped";

  IF canonical_catalog IS DISTINCT FROM jsonb_build_object(
    'type', 'uuid',
    'notNull', false,
    'hasDefault', false,
    'identity', '',
    'generated', '',
    'hasMissing', false
  ) THEN
    RAISE EXCEPTION 'Unexpected surviving Agent Run canonical model key catalog: %', canonical_catalog;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_index" AS "index_row"
    WHERE "index_row"."indrelid" = agent_runs_oid
      AND canonical_attnum = ANY("index_row"."indkey"::smallint[])
  ) OR EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_constraint" AS "constraint_row"
    WHERE "constraint_row"."contype" = 'f'
      AND (
        (
          "constraint_row"."conrelid" = agent_runs_oid
          AND canonical_attnum = ANY("constraint_row"."conkey")
        ) OR (
          "constraint_row"."confrelid" = agent_runs_oid
          AND canonical_attnum = ANY("constraint_row"."confkey")
        )
      )
  ) THEN
    RAISE EXCEPTION 'Surviving Agent Run canonical model key gained an index or foreign key';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_trigger"
    WHERE "tgrelid" = agent_runs_oid
      AND "tgname" = 'sync_agent_run_model_key_ids_0971'
      AND NOT "tgisinternal"
  ) OR EXISTS (
    SELECT 1
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" = 'sync_agent_run_model_key_ids_0971'
  ) THEN
    RAISE EXCEPTION 'Agent Run 0971 bridge objects remain after contract';
  END IF;

  SELECT
    "constraint_row"."oid",
    pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
  INTO metadata_constraint_oid, metadata_definition
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  WHERE "constraint_row"."conrelid" = agent_runs_oid
    AND "constraint_row"."conname" = 'agent_runs_metadata_presence_check'
    AND "constraint_row"."contype" = 'c'
    AND "constraint_row"."convalidated"
    AND NOT "constraint_row"."condeferrable"
    AND NOT "constraint_row"."condeferred"
    AND "constraint_row"."conislocal"
    AND "constraint_row"."coninhcount" = 0
    AND NOT "constraint_row"."connoinherit";

  SELECT array_agg("attribute_row"."attname" ORDER BY "attribute_row"."attname")
  INTO metadata_columns
  FROM "pg_catalog"."pg_constraint" AS "constraint_row"
  CROSS JOIN LATERAL unnest("constraint_row"."conkey") AS "key_row"("attnum")
  INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
    ON "attribute_row"."attrelid" = "constraint_row"."conrelid"
    AND "attribute_row"."attnum" = "key_row"."attnum"
  WHERE "constraint_row"."oid" = metadata_constraint_oid;

  IF metadata_constraint_oid IS NULL
    OR metadata_columns IS DISTINCT FROM ARRAY[
      'api_started_at',
      'autonomy_budget',
      'built_in_model_key_id',
      'chat_thread_id',
      'codex_service_tier',
      'first_assistant_event_acknowledged_at',
      'goal_id',
      'model_provider',
      'model_provider_credential_scope',
      'model_provider_id',
      'model_runtime_model',
      'model_runtime_provider',
      'selected_image_model',
      'selected_model',
      'selected_video_model',
      'summary',
      'trigger_brief',
      'trigger_source',
      'workflow_automation_id'
    ]::text[]
    OR pg_catalog.md5(metadata_definition) <>
      '20ee7ec050f6cd8c9559505d3e7ce2a6'
    OR pg_catalog.regexp_count(metadata_definition, ' IS NULL') <> 19
    OR pg_catalog.regexp_count(metadata_definition, ' IS NOT NULL') <> 2
    OR metadata_definition ~* '\mvm0_model_key_id\M'
    OR position('built_in_model_key_id IS NULL' IN metadata_definition) = 0
    OR position('trigger_source IS NOT NULL' IN metadata_definition) = 0
    OR position('autonomy_budget IS NOT NULL' IN metadata_definition) = 0
  THEN
    RAISE EXCEPTION
      'Unexpected final Agent Run metadata-presence check: columns=%, definition=%',
      metadata_columns,
      metadata_definition;
  END IF;

  SELECT jsonb_build_object(
    'rowCount', count(*),
    'nonNullCount', count("built_in_model_key_id"),
    'nonNullHash', CASE
      WHEN count("built_in_model_key_id") = 0 THEN NULL
      ELSE pg_catalog.md5(
        string_agg(
          "id"::text || ':' || "built_in_model_key_id"::text,
          ',' ORDER BY "id"
        ) FILTER (WHERE "built_in_model_key_id" IS NOT NULL)
      )
    END
  )::text
  INTO canonical_fingerprint
  FROM "agent_runs";

  IF canonical_fingerprint IS DISTINCT FROM pg_catalog.current_setting(
    'vm0.agent_run_model_key_contract_fingerprint'
  ) THEN
    RAISE EXCEPTION 'Agent Run canonical model key data changed during contract';
  END IF;

  WITH "catalog_definitions" AS (
    SELECT
      'routine'::text AS "kind",
      format(
        '%I.%I(%s)',
        "namespace_row"."nspname",
        "function_row"."proname",
        pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
      ) AS "object_name",
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

    UNION ALL

    SELECT
      'rule',
      format(
        '%I.%I.%I',
        "namespace_row"."nspname",
        "relation_row"."relname",
        "rule_row"."rulename"
      ),
      pg_catalog.pg_get_ruledef("rule_row"."oid", true)
    FROM "pg_catalog"."pg_rewrite" AS "rule_row"
    INNER JOIN "pg_catalog"."pg_class" AS "relation_row"
      ON "relation_row"."oid" = "rule_row"."ev_class"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "relation_row"."relnamespace"
    WHERE "namespace_row"."nspname" NOT IN (
        'pg_catalog',
        'information_schema'
      )
      AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'

    UNION ALL

    SELECT
      'trigger',
      format(
        '%I.%I.%I',
        "namespace_row"."nspname",
        "relation_row"."relname",
        "trigger_row"."tgname"
      ),
      pg_catalog.pg_get_triggerdef("trigger_row"."oid", true)
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "relation_row"
      ON "relation_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "relation_row"."relnamespace"
    WHERE NOT "trigger_row"."tgisinternal"
      AND "namespace_row"."nspname" NOT IN (
        'pg_catalog',
        'information_schema'
      )
      AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'

    UNION ALL

    SELECT
      'constraint',
      format(
        '%I.%I',
        "namespace_row"."nspname",
        "constraint_row"."conname"
      ),
      pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
    FROM "pg_catalog"."pg_constraint" AS "constraint_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "constraint_row"."connamespace"
    WHERE "namespace_row"."nspname" NOT IN (
        'pg_catalog',
        'information_schema'
      )
      AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'

    UNION ALL

    SELECT
      'index',
      format('%I.%I', "namespace_row"."nspname", "index_row"."relname"),
      pg_catalog.pg_get_indexdef("index_row"."oid")
    FROM "pg_catalog"."pg_index" AS "index_catalog"
    INNER JOIN "pg_catalog"."pg_class" AS "index_row"
      ON "index_row"."oid" = "index_catalog"."indexrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "index_row"."relnamespace"
    WHERE "namespace_row"."nspname" NOT IN (
        'pg_catalog',
        'information_schema'
      )
      AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'

    UNION ALL

    SELECT
      'default',
      format(
        '%I.%I.%I',
        "namespace_row"."nspname",
        "relation_row"."relname",
        "attribute_row"."attname"
      ),
      pg_catalog.pg_get_expr(
        "default_row"."adbin",
        "default_row"."adrelid",
        true
      )
    FROM "pg_catalog"."pg_attrdef" AS "default_row"
    INNER JOIN "pg_catalog"."pg_class" AS "relation_row"
      ON "relation_row"."oid" = "default_row"."adrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "relation_row"."relnamespace"
    INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
      ON "attribute_row"."attrelid" = "default_row"."adrelid"
      AND "attribute_row"."attnum" = "default_row"."adnum"
    WHERE "namespace_row"."nspname" NOT IN (
        'pg_catalog',
        'information_schema'
      )
      AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'
  )
  SELECT array_agg(
    "kind" || ' ' || "object_name"
    ORDER BY "kind", "object_name"
  )
  INTO residual_catalog_objects
  FROM "catalog_definitions"
  WHERE "definition" ~* '\mvm0_model_key_id\M';

  IF residual_catalog_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Agent Run legacy model key catalog references remain: %', residual_catalog_objects;
  END IF;
END;
$$;
