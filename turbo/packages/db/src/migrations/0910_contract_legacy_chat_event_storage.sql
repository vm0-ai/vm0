-- Contract the legacy physical chat-event storage only after the canonical-only
-- API release and its older writers have drained. Keep the catalog audit,
-- bridge removal, constraint rewrite, and column drops atomic under one lock.
LOCK TABLE "chat_events", "zero_runs" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
  chat_event_columns jsonb;
  zero_run_columns jsonb;
  bridge_count integer;
  legacy_index_count integer;
BEGIN
  SELECT jsonb_object_agg("attname", format_type("atttypid", "atttypmod"))
  INTO chat_event_columns
  FROM "pg_attribute"
  WHERE "attrelid" = 'public.chat_events'::regclass
    AND "attname" IN (
      'content',
      'user_message',
      'thinking',
      'error',
      'usage_payload',
      'interrupts_run_id',
      'run_group_id'
    )
    AND "attnum" > 0
    AND NOT "attisdropped";

  IF chat_event_columns IS DISTINCT FROM jsonb_build_object(
    'content', 'text',
    'user_message', 'jsonb',
    'thinking', 'text',
    'error', 'text',
    'usage_payload', 'jsonb',
    'interrupts_run_id', 'uuid',
    'run_group_id', 'uuid'
  ) THEN
    RAISE EXCEPTION 'Unexpected legacy chat_events column catalog: %', chat_event_columns;
  END IF;

  SELECT jsonb_object_agg("attname", format_type("atttypid", "atttypmod"))
  INTO zero_run_columns
  FROM "pg_attribute"
  WHERE "attrelid" = 'public.zero_runs'::regclass
    AND "attname" = 'run_group_id'
    AND "attnum" > 0
    AND NOT "attisdropped";

  IF zero_run_columns IS DISTINCT FROM jsonb_build_object('run_group_id', 'uuid') THEN
    RAISE EXCEPTION 'Unexpected legacy zero_runs column catalog: %', zero_run_columns;
  END IF;

  SELECT COUNT(*)
  INTO legacy_index_count
  FROM "pg_index" AS "index_catalog"
  INNER JOIN "pg_class" AS "index_relation"
    ON "index_relation"."oid" = "index_catalog"."indexrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "index_relation"."relnamespace"
  WHERE "namespace"."nspname" = 'public'
    AND "index_relation"."relname" IN (
      'chat_events_usage_run_id_idx',
      'chat_events_interrupts_run_id_not_null_unique',
      'chat_events_run_thinking_unique',
      'idx_zero_runs_run_group'
    )
    AND "index_catalog"."indisvalid"
    AND "index_catalog"."indisready"
    AND "index_catalog"."indislive";

  IF legacy_index_count <> 4 THEN
    RAISE EXCEPTION 'Expected four valid legacy indexes, found %', legacy_index_count;
  END IF;

  SELECT COUNT(*)
  INTO bridge_count
  FROM "pg_trigger"
  WHERE NOT "tgisinternal"
    AND "tgenabled" <> 'D'
    AND (
      ("tgrelid" = 'public.chat_events'::regclass
        AND "tgname" IN (
          'bridge_goal_only_chat_event_run_group_0810',
          'bridge_invalidated_goal_continuation_0829'
        ))
      OR ("tgrelid" = 'public.zero_runs'::regclass
        AND "tgname" = 'bridge_goal_only_zero_run_group_0810')
    );

  IF bridge_count <> 3 THEN
    RAISE EXCEPTION 'Expected three enabled legacy bridge triggers, found %', bridge_count;
  END IF;

  SELECT COUNT(*)
  INTO bridge_count
  FROM "pg_proc" AS "routine"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "routine"."pronamespace"
  WHERE "namespace"."nspname" = 'public'
    AND "routine"."pronargs" = 0
    AND "routine"."proname" IN (
      'bridge_goal_only_chat_event_run_group_0810',
      'bridge_goal_only_zero_run_group_0810',
      'bridge_invalidated_goal_continuation_0829'
    );

  IF bridge_count <> 3 THEN
    RAISE EXCEPTION 'Expected three legacy bridge functions, found %', bridge_count;
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

-- A canonical-only row legitimately has null legacy leaves. For every legacy
-- value that does remain, require the canonical value that will survive.
DO $$
DECLARE
  residual_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO residual_count
  FROM "chat_events"
  WHERE ("content" IS NOT NULL
      AND "payload" -> 'content' IS DISTINCT FROM to_jsonb("content"))
    OR ("user_message" IS NOT NULL
      AND "payload" -> 'userMessage' IS DISTINCT FROM "user_message")
    OR ("thinking" IS NOT NULL
      AND "payload" -> 'thinking' IS DISTINCT FROM to_jsonb("thinking"))
    OR ("error" IS NOT NULL
      AND "payload" -> 'error' IS DISTINCT FROM to_jsonb("error"))
    OR ("usage_payload" IS NOT NULL
      AND "payload" -> 'usage' IS DISTINCT FROM "usage_payload");
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % rows whose legacy payload leaves lack canonical values',
      residual_count;
  END IF;

  SELECT COUNT(*)
  INTO residual_count
  FROM "chat_events"
  WHERE "event_type" = 'control.interrupt'
    AND "interrupts_run_id" IS NOT NULL
    AND "run_id" IS DISTINCT FROM "interrupts_run_id";
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % legacy interrupts without canonical run_id pointers',
      residual_count;
  END IF;

  SELECT COUNT(*)
  INTO residual_count
  FROM "chat_events"
  WHERE "run_group_id" IS NOT NULL
    AND ("context_type" IS DISTINCT FROM 'goal'
      OR "context_id" IS DISTINCT FROM "run_group_id");
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % legacy goal groups without canonical context pointers',
      residual_count;
  END IF;

  SELECT COUNT(*)
  INTO residual_count
  FROM "zero_runs"
  WHERE "run_group_id" IS NOT NULL
    AND "goal_id" IS DISTINCT FROM "run_group_id"
    AND EXISTS (
      SELECT 1
      FROM "thread_goals"
      WHERE "thread_goals"."id" = "zero_runs"."run_group_id"
    );
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'zero_runs has % legacy goal groups without canonical goal_id pointers',
      residual_count;
  END IF;
END;
$$;--> statement-breakpoint

-- Remove bridge triggers before the functions and columns they reference.
DROP TRIGGER "bridge_goal_only_chat_event_run_group_0810" ON "chat_events";--> statement-breakpoint
DROP TRIGGER "bridge_invalidated_goal_continuation_0829" ON "chat_events";--> statement-breakpoint
DROP TRIGGER "bridge_goal_only_zero_run_group_0810" ON "zero_runs";--> statement-breakpoint
DROP FUNCTION "bridge_goal_only_chat_event_run_group_0810"();--> statement-breakpoint
DROP FUNCTION "bridge_invalidated_goal_continuation_0829"();--> statement-breakpoint
DROP FUNCTION "bridge_goal_only_zero_run_group_0810"();--> statement-breakpoint

ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_goal_marker_payload_check";--> statement-breakpoint
DROP INDEX "chat_events_usage_run_id_idx";--> statement-breakpoint
DROP INDEX "chat_events_interrupts_run_id_not_null_unique";--> statement-breakpoint
DROP INDEX "chat_events_run_thinking_unique";--> statement-breakpoint
DROP INDEX "idx_zero_runs_run_group";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "usage_payload";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "interrupts_run_id";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "run_group_id";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "content";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "user_message";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "thinking";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "error";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "run_group_id";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_goal_marker_payload_check" CHECK ("chat_events"."event_type" NOT IN ('goal.open', 'goal.close')
          OR (
            "chat_events"."run_id" IS NULL
            AND "chat_events"."revokes_event_id" IS NULL
            AND "chat_events"."context_type" IS NULL
            AND "chat_events"."context_id" IS NULL
            AND "chat_events"."run_event_sequence_number" IS NULL
            AND "chat_events"."run_event_id" IS NULL
          ));--> statement-breakpoint

DO $$
DECLARE
  actual_chat_event_columns text[];
  goal_marker_columns text[];
  goal_marker_definition text;
  goal_marker_validated boolean;
BEGIN
  SELECT array_agg("attname" ORDER BY "attname")
  INTO actual_chat_event_columns
  FROM "pg_attribute"
  WHERE "attrelid" = 'public.chat_events'::regclass
    AND "attnum" > 0
    AND NOT "attisdropped";

  IF actual_chat_event_columns IS DISTINCT FROM ARRAY[
    'chat_thread_id',
    'context_id',
    'context_type',
    'created_at',
    'event_type',
    'id',
    'payload',
    'revokes_event_id',
    'run_event_id',
    'run_event_sequence_number',
    'run_id',
    'seq_id'
  ]::text[] THEN
    RAISE EXCEPTION 'Unexpected final chat_events columns: %', actual_chat_event_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_attribute"
    WHERE "attrelid" = 'public.zero_runs'::regclass
      AND "attname" = 'run_group_id'
      AND "attnum" > 0
      AND NOT "attisdropped"
  ) OR NOT EXISTS (
    SELECT 1
    FROM "pg_attribute"
    WHERE "attrelid" = 'public.zero_runs'::regclass
      AND "attname" = 'goal_id'
      AND "attnum" > 0
      AND NOT "attisdropped"
  ) THEN
    RAISE EXCEPTION 'Unexpected final zero_runs goal provenance columns';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_class" AS "relation"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "relation"."relname" IN (
        'chat_events_usage_run_id_idx',
        'chat_events_interrupts_run_id_not_null_unique',
        'chat_events_run_thinking_unique',
        'idx_zero_runs_run_group'
      )
  ) THEN
    RAISE EXCEPTION 'A legacy chat-event storage index remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE NOT "tgisinternal"
      AND "tgname" IN (
        'bridge_goal_only_chat_event_run_group_0810',
        'bridge_goal_only_zero_run_group_0810',
        'bridge_invalidated_goal_continuation_0829'
      )
  ) OR EXISTS (
    SELECT 1
    FROM "pg_proc" AS "routine"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "routine"."pronamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "routine"."pronargs" = 0
      AND "routine"."proname" IN (
        'bridge_goal_only_chat_event_run_group_0810',
        'bridge_goal_only_zero_run_group_0810',
        'bridge_invalidated_goal_continuation_0829'
      )
  ) THEN
    RAISE EXCEPTION 'A legacy chat-event bridge object remains';
  END IF;

  SELECT "convalidated", pg_get_constraintdef("oid", true)
  INTO goal_marker_validated, goal_marker_definition
  FROM "pg_constraint"
  WHERE "conrelid" = 'public.chat_events'::regclass
    AND "conname" = 'chat_events_goal_marker_payload_check'
    AND "contype" = 'c';

  SELECT array_agg("attribute"."attname" ORDER BY "attribute"."attname")
  INTO goal_marker_columns
  FROM "pg_constraint" AS "constraint"
  CROSS JOIN LATERAL unnest("constraint"."conkey") AS "key"("attnum")
  INNER JOIN "pg_attribute" AS "attribute"
    ON "attribute"."attrelid" = "constraint"."conrelid"
    AND "attribute"."attnum" = "key"."attnum"
  WHERE "constraint"."conrelid" = 'public.chat_events'::regclass
    AND "constraint"."conname" = 'chat_events_goal_marker_payload_check';

  IF goal_marker_definition IS NULL OR NOT goal_marker_validated
    OR goal_marker_columns IS DISTINCT FROM ARRAY[
      'context_id',
      'context_type',
      'event_type',
      'revokes_event_id',
      'run_event_id',
      'run_event_sequence_number',
      'run_id'
    ]::text[]
    OR goal_marker_definition ~* '\m(content|user_message|thinking|error|usage_payload|interrupts_run_id|run_group_id)\M'
  THEN
    RAISE EXCEPTION
      'Unexpected final goal-marker constraint: columns=%, definition=%',
      goal_marker_columns,
      goal_marker_definition;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "pg_index"
    WHERE "indrelid" IN (
        'public.chat_events'::regclass,
        'public.zero_runs'::regclass
      )
      AND (NOT "indisvalid" OR NOT "indisready" OR NOT "indislive")
  ) THEN
    RAISE EXCEPTION 'Final chat-event storage contains an invalid index';
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
END;
$$;
