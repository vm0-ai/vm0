-- Phase 7B removes the retired physical storage after the Phase 7A API and
-- every active R2 snapshot head converged to the canonical contract. Keep the
-- audit, contraction, and final catalog checks in one transaction and under
-- one lock so an unexpected dependency rolls the entire migration back.
LOCK TABLE "chat_events" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
  retired_columns jsonb;
BEGIN
  SELECT jsonb_object_agg(
    "attname",
    format_type("atttypid", "atttypmod")
  )
  INTO retired_columns
  FROM "pg_attribute"
  WHERE "attrelid" = 'public.chat_events'::regclass
    AND "attname" IN (
      'active_input_sequence',
      'goal_event',
      'attach_files',
      'generation_template',
      'recommended_followups'
    )
    AND "attnum" > 0
    AND NOT "attisdropped";

  IF retired_columns IS DISTINCT FROM jsonb_build_object(
    'active_input_sequence', 'integer',
    'goal_event', 'jsonb',
    'attach_files', 'jsonb',
    'generation_template', 'jsonb',
    'recommended_followups', 'jsonb'
  ) THEN
    RAISE EXCEPTION 'Unexpected retired chat_events column catalog: %', retired_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_index"
    WHERE "indexrelid" =
      'public.chat_events_run_active_input_seq_unique'::regclass
      AND "indrelid" = 'public.chat_events'::regclass
      AND "indisvalid"
      AND "indisready"
      AND "indislive"
  ) THEN
    RAISE EXCEPTION 'chat_events active-input index is missing or invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conrelid" = 'public.chat_events'::regclass
      AND "conname" = 'chat_events_goal_marker_payload_check'
      AND "contype" = 'c'
      AND "convalidated"
  ) THEN
    RAISE EXCEPTION 'chat_events goal-marker constraint is missing or invalid';
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_goal_marker_payload_check";--> statement-breakpoint
DROP INDEX "chat_events_run_active_input_seq_unique";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "active_input_sequence";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "goal_event";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "attach_files";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "generation_template";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "recommended_followups";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_goal_marker_payload_check" CHECK ("chat_events"."event_type" NOT IN ('goal.open', 'goal.close')
          OR (
            "chat_events"."run_id" IS NULL
            AND "chat_events"."usage_payload" IS NULL
            AND "chat_events"."revokes_event_id" IS NULL
            AND "chat_events"."interrupts_run_id" IS NULL
            AND "chat_events"."run_group_id" IS NULL
            AND "chat_events"."context_type" IS NULL
            AND "chat_events"."context_id" IS NULL
            AND "chat_events"."user_message" IS NULL
            AND "chat_events"."thinking" IS NULL
            AND "chat_events"."error" IS NULL
            AND "chat_events"."run_event_sequence_number" IS NULL
            AND "chat_events"."run_event_id" IS NULL
          ));--> statement-breakpoint

DO $$
DECLARE
  actual_columns text[];
  goal_marker_columns text[];
  goal_marker_definition text;
  goal_marker_validated boolean;
  residual_catalog_objects text;
BEGIN
  SELECT array_agg("attname" ORDER BY "attname")
  INTO actual_columns
  FROM "pg_attribute"
  WHERE "attrelid" = 'public.chat_events'::regclass
    AND "attnum" > 0
    AND NOT "attisdropped";

  IF actual_columns IS DISTINCT FROM ARRAY[
    'chat_thread_id',
    'content',
    'context_id',
    'context_type',
    'created_at',
    'error',
    'event_type',
    'id',
    'interrupts_run_id',
    'revokes_event_id',
    'run_event_id',
    'run_event_sequence_number',
    'run_group_id',
    'run_id',
    'seq_id',
    'thinking',
    'usage_payload',
    'user_message'
  ]::text[] THEN
    RAISE EXCEPTION 'Unexpected final chat_events columns: %', actual_columns;
  END IF;

  IF to_regclass('public.chat_events_run_active_input_seq_unique') IS NOT NULL
  THEN
    RAISE EXCEPTION 'Retired chat_events active-input index remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_attribute"
    WHERE "attrelid" = 'public.chat_events'::regclass
      AND "attname" IN (
        'active_input_sequence',
        'goal_event',
        'attach_files',
        'generation_template',
        'recommended_followups'
      )
      AND "attnum" > 0
      AND NOT "attisdropped"
  ) THEN
    RAISE EXCEPTION 'Retired chat_events columns remain';
  END IF;

  SELECT "convalidated", pg_get_constraintdef("oid", true)
  INTO goal_marker_validated, goal_marker_definition
  FROM "pg_constraint"
  WHERE "conrelid" = 'public.chat_events'::regclass
    AND "conname" = 'chat_events_goal_marker_payload_check'
    AND "contype" = 'c';

  IF goal_marker_definition IS NULL OR NOT goal_marker_validated THEN
    RAISE EXCEPTION 'Final chat_events goal-marker constraint is missing or invalid';
  END IF;

  SELECT array_agg("attribute"."attname" ORDER BY "attribute"."attname")
  INTO goal_marker_columns
  FROM "pg_constraint" AS "constraint"
  CROSS JOIN LATERAL unnest("constraint"."conkey") AS "key"("attnum")
  INNER JOIN "pg_attribute" AS "attribute"
    ON "attribute"."attrelid" = "constraint"."conrelid"
    AND "attribute"."attnum" = "key"."attnum"
  WHERE "constraint"."conrelid" = 'public.chat_events'::regclass
    AND "constraint"."conname" = 'chat_events_goal_marker_payload_check';

  IF goal_marker_columns IS DISTINCT FROM ARRAY[
    'context_id',
    'context_type',
    'error',
    'event_type',
    'interrupts_run_id',
    'revokes_event_id',
    'run_event_id',
    'run_event_sequence_number',
    'run_group_id',
    'run_id',
    'thinking',
    'usage_payload',
    'user_message'
  ]::text[] THEN
    RAISE EXCEPTION 'Unexpected goal-marker constraint columns: %', goal_marker_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_index"
    WHERE "indrelid" = 'public.chat_events'::regclass
      AND (NOT "indisvalid" OR NOT "indisready" OR NOT "indislive")
  ) THEN
    RAISE EXCEPTION 'Final chat_events contains an invalid index';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND "tgenabled" <> 'D'
  ) THEN
    RAISE EXCEPTION 'chat_events append-only trigger must remain enabled';
  END IF;

  WITH catalog_definitions AS (
    SELECT
      'routine'::text AS "kind",
      format(
        '%I.%I(%s)',
        "namespace"."nspname",
        "routine"."proname",
        pg_get_function_identity_arguments("routine"."oid")
      ) AS "object_name",
      "routine"."prosrc"::text AS "definition"
    FROM "pg_proc" AS "routine"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "routine"."pronamespace"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'
      AND "routine"."prokind" IN ('f', 'p')

    UNION ALL

    SELECT
      'view',
      format('%I.%I', "namespace"."nspname", "relation"."relname"),
      pg_get_viewdef("relation"."oid", true)
    FROM "pg_class" AS "relation"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'
      AND "relation"."relkind" IN ('v', 'm')

    UNION ALL

    SELECT
      'trigger',
      format(
        '%I.%I.%I',
        "namespace"."nspname",
        "relation"."relname",
        "trigger"."tgname"
      ),
      pg_get_triggerdef("trigger"."oid", true)
    FROM "pg_trigger" AS "trigger"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "trigger"."tgrelid"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'
      AND NOT "trigger"."tgisinternal"

    UNION ALL

    SELECT
      'rule',
      format(
        '%I.%I.%I',
        "namespace"."nspname",
        "relation"."relname",
        "rule"."rulename"
      ),
      pg_get_ruledef("rule"."oid", true)
    FROM "pg_rewrite" AS "rule"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "rule"."ev_class"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'

    UNION ALL

    SELECT
      'constraint',
      format('%I.%I', "namespace"."nspname", "constraint"."conname"),
      pg_get_constraintdef("constraint"."oid", true)
    FROM "pg_constraint" AS "constraint"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "constraint"."connamespace"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'

    UNION ALL

    SELECT
      'index',
      format('%I.%I', "namespace"."nspname", "index"."relname"),
      pg_get_indexdef("index"."oid")
    FROM "pg_index" AS "index_catalog"
    INNER JOIN "pg_class" AS "index"
      ON "index"."oid" = "index_catalog"."indexrelid"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "index"."relnamespace"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'

    UNION ALL

    SELECT
      'default',
      format(
        '%I.%I.%I',
        "namespace"."nspname",
        "relation"."relname",
        "attribute"."attname"
      ),
      pg_get_expr("default"."adbin", "default"."adrelid", true)
    FROM "pg_attrdef" AS "default"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "default"."adrelid"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    INNER JOIN "pg_attribute" AS "attribute"
      ON "attribute"."attrelid" = "default"."adrelid"
      AND "attribute"."attnum" = "default"."adnum"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'

    UNION ALL

    SELECT
      'policy',
      format(
        '%I.%I.%I',
        "namespace"."nspname",
        "relation"."relname",
        "policy"."polname"
      ),
      concat_ws(
        ' ',
        pg_get_expr("policy"."polqual", "policy"."polrelid", true),
        pg_get_expr("policy"."polwithcheck", "policy"."polrelid", true)
      )
    FROM "pg_policy" AS "policy"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "policy"."polrelid"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" <> 'information_schema'
      AND "namespace"."nspname" !~ '^pg_'
  )
  SELECT string_agg(
    "kind" || ' ' || "object_name",
    ', ' ORDER BY "kind", "object_name"
  )
  INTO residual_catalog_objects
  FROM catalog_definitions
  WHERE "definition" ~* '\m(active_input_sequence|goal_event|attach_files|generation_template|recommended_followups)\M';

  IF residual_catalog_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Retired chat_events catalog references remain: %', residual_catalog_objects;
  END IF;
END;
$$;
