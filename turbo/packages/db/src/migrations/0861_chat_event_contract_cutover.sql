-- Stage 5 atomically cuts application readers and writers to the canonical
-- chat-event contract. Lock in the same order as goal writers before changing
-- the stream so no goal mutation or late old-API insert can straddle the
-- historical cutover.
LOCK TABLE "thread_goals" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "chat_threads" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "chat_events" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- This validator is part of the temporary Stage 5 DB-before-API bridge. Stage
-- 7 must drop it together with canonicalize_legacy_chat_event_insert_0861 and
-- its trigger after the Stage 6 client floor and the complete API drain.
-- Follow-up: https://github.com/vm0-ai/vm0/issues/25767.
CREATE FUNCTION "is_supported_legacy_followups_0861"(payload jsonb)
RETURNS boolean AS $$
DECLARE
  item jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'array' THEN
    RETURN false;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(payload)
  LOOP
    IF jsonb_typeof(item) <> 'object'
      OR jsonb_typeof(item -> 'prompt') <> 'string'
      OR jsonb_typeof(item -> 'kind') <> 'string'
      OR item ->> 'kind' NOT IN ('talk', 'generate')
      OR item - ARRAY['prompt', 'kind', 'generationType']::text[] <> '{}'::jsonb
      OR (
        item ? 'generationType'
        AND (
          jsonb_typeof(item -> 'generationType') <> 'string'
          OR item ->> 'generationType' NOT IN (
            'image',
            'video',
            'presentation',
            'website'
          )
        )
      )
    THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint

-- Mandatory Stage 7 deletion. This bridge exists only for the observed
-- DB-before-API rolling window (up to ~102 minutes): old API pods can still
-- insert goal.changed + goal_event or output.followups +
-- recommended_followups after this migration is live. It upgrades only those
-- exact legacy signatures and leaves every canonical insert unchanged.
-- Removal is tracked by https://github.com/vm0-ai/vm0/issues/25767.
CREATE FUNCTION "canonicalize_legacy_chat_event_insert_0861"()
RETURNS trigger AS $$
DECLARE
  goal_type text;
  goal_status text;
  objective_brief text;
BEGIN
  IF NEW."event_type" = 'goal.changed' THEN
    IF NEW."content" IS NOT NULL
      OR NEW."goal_event" IS NULL
      OR jsonb_typeof(NEW."goal_event") <> 'object'
      OR NEW."run_id" IS NOT NULL
      OR NEW."usage_payload" IS NOT NULL
      OR NEW."revokes_event_id" IS NOT NULL
      OR NEW."interrupts_run_id" IS NOT NULL
      OR NEW."run_group_id" IS NOT NULL
      OR NEW."context_type" IS NOT NULL
      OR NEW."context_id" IS NOT NULL
      OR NEW."user_message" IS NOT NULL
      OR NEW."thinking" IS NOT NULL
      OR NEW."error" IS NOT NULL
      OR NEW."active_input_sequence" IS NOT NULL
      OR NEW."run_event_sequence_number" IS NOT NULL
      OR NEW."run_event_id" IS NOT NULL
      OR NEW."attach_files" IS NOT NULL
      OR NEW."generation_template" IS NOT NULL
      OR NEW."recommended_followups" IS NOT NULL
    THEN
      RAISE EXCEPTION 'Malformed legacy goal.changed payload';
    END IF;

    goal_type := NEW."goal_event" ->> 'type';
    goal_status := NEW."goal_event" ->> 'status';
    IF goal_type = 'state' AND goal_status = 'active' THEN
      IF jsonb_typeof(NEW."goal_event" -> 'objectiveBrief') <> 'string'
        OR NEW."goal_event"
          - ARRAY['type', 'status', 'objectiveBrief']::text[] <> '{}'::jsonb
      THEN
        RAISE EXCEPTION 'Malformed legacy active goal.changed payload';
      END IF;
      objective_brief := btrim(NEW."goal_event" ->> 'objectiveBrief');
      IF objective_brief = '' THEN
        RAISE EXCEPTION 'Legacy active goal.changed objective is empty';
      END IF;
      NEW."event_type" := 'goal.open';
      NEW."content" := objective_brief;
    ELSIF goal_type = 'state'
      AND goal_status IN ('paused', 'blocked', 'complete')
      AND NEW."goal_event" - ARRAY['type', 'status']::text[] = '{}'::jsonb
    THEN
      NEW."event_type" := 'goal.close';
      NEW."content" := NULL;
    ELSIF goal_type = 'cleared'
      AND NEW."goal_event" - ARRAY['type']::text[] = '{}'::jsonb
    THEN
      NEW."event_type" := 'goal.close';
      NEW."content" := NULL;
    ELSE
      RAISE EXCEPTION 'Malformed legacy goal.changed state';
    END IF;

    NEW."goal_event" := NULL;
    RETURN NEW;
  END IF;

  IF NEW."event_type" = 'output.followups'
    AND NEW."recommended_followups" IS NOT NULL
  THEN
    IF NEW."content" IS NOT NULL
      OR NOT "is_supported_legacy_followups_0861"(
        NEW."recommended_followups"
      )
    THEN
      RAISE EXCEPTION 'Malformed legacy output.followups payload';
    END IF;

    NEW."content" := jsonb_build_object(
      'version', 1,
      'followups', NEW."recommended_followups"
    )::text;
    NEW."recommended_followups" := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "canonicalize_legacy_chat_event_insert_0861"
BEFORE INSERT ON "chat_events"
FOR EACH ROW
WHEN (
  NEW."event_type" = 'goal.changed'
  OR (
    NEW."event_type" = 'output.followups'
    AND NEW."recommended_followups" IS NOT NULL
  )
)
EXECUTE FUNCTION "canonicalize_legacy_chat_event_insert_0861"();--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events"
    WHERE "event_type" = 'output.followups'
      AND "recommended_followups" IS NOT NULL
      AND NOT "is_supported_legacy_followups_0861"(
        "recommended_followups"
      )
  ) THEN
    RAISE EXCEPTION 'Malformed historical output.followups payload';
  END IF;
END;
$$;--> statement-breakpoint

-- Preserve immutable-event enforcement while allowing exactly the in-place
-- legacy followup payload rewrite. Identity, ordering, run metadata,
-- timestamps, and revoke relationships must remain byte-for-byte unchanged.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."event_type" = 'output.followups'
    AND OLD."recommended_followups" IS NOT NULL
    AND "is_supported_legacy_followups_0861"(
      OLD."recommended_followups"
    )
    AND NEW."recommended_followups" IS NULL
    AND NEW."content" = jsonb_build_object(
      'version', 1,
      'followups', OLD."recommended_followups"
    )::text
    AND (to_jsonb(NEW) - ARRAY['content', 'recommended_followups']::text[])
      = (to_jsonb(OLD) - ARRAY['content', 'recommended_followups']::text[])
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

UPDATE "chat_events"
SET
  "content" = jsonb_build_object(
    'version', 1,
    'followups', "recommended_followups"
  )::text,
  "recommended_followups" = NULL
WHERE "event_type" = 'output.followups'
  AND "recommended_followups" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Goal markers are UI projections, not history. Delete every legacy marker
-- and the recursive revoke chain that directly depends on it; seq_id values
-- are intentionally not compacted or reused.
WITH RECURSIVE "legacy_goal_event_ids"("id") AS (
  SELECT "id"
  FROM "chat_events"
  WHERE "event_type" = 'goal.changed'

  UNION

  SELECT "dependent"."id"
  FROM "chat_events" AS "dependent"
  INNER JOIN "legacy_goal_event_ids" AS "legacy"
    ON "dependent"."revokes_event_id" = "legacy"."id"
  WHERE "dependent"."event_type" = 'control.revoke'
)
DELETE FROM "chat_events"
WHERE "id" IN (SELECT "id" FROM "legacy_goal_event_ids");--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "thread_goals"
    WHERE "status" = 'active'
      AND btrim("objective_brief") = ''
  ) THEN
    RAISE EXCEPTION 'Active thread goal objective_brief is empty';
  END IF;
END;
$$;--> statement-breakpoint

-- Re-project current mutable state only: append one fresh goal.open for every
-- goal that is active at the cutover snapshot. No historical goal state is
-- reconstructed.
WITH "active_goals" AS MATERIALIZED (
  SELECT
    "chat_thread_id",
    btrim("objective_brief") AS "objective_brief"
  FROM "thread_goals"
  WHERE "status" = 'active'
  ORDER BY "chat_thread_id"
), "advanced_threads" AS (
  UPDATE "chat_threads" AS "thread"
  SET "last_chat_event_seq_id" = "thread"."last_chat_event_seq_id" + 1
  FROM "active_goals" AS "goal"
  WHERE "thread"."id" = "goal"."chat_thread_id"
  RETURNING
    "thread"."id" AS "chat_thread_id",
    "thread"."last_chat_event_seq_id" AS "seq_id"
)
INSERT INTO "chat_events" (
  "id",
  "chat_thread_id",
  "event_type",
  "content",
  "seq_id",
  "created_at"
)
SELECT
  gen_random_uuid(),
  "goal"."chat_thread_id",
  'goal.open',
  "goal"."objective_brief",
  "thread"."seq_id",
  statement_timestamp()::timestamp
FROM "active_goals" AS "goal"
INNER JOIN "advanced_threads" AS "thread"
  ON "thread"."chat_thread_id" = "goal"."chat_thread_id";--> statement-breakpoint

ALTER TABLE "chat_events"
DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "chat_events"
ADD CONSTRAINT "chat_events_event_type_check" CHECK (
  "chat_events"."event_type" IN (
    'input.prompt',
    'input.automation',
    'input.goal',
    'input.budget',
    'input.rejected',
    'output.message',
    'output.error',
    'output.thinking',
    'output.followups',
    'run.queued',
    'run.dequeued',
    'run.completed',
    'run.failed',
    'run.cancelled',
    'control.interrupt',
    'control.revoke',
    'browser.open',
    'browser.close',
    -- Existing browser lifecycle physical compatibility is unchanged here.
    'browser.started',
    'browser.stopped',
    'goal.open',
    'goal.close',
    'usage.recorded'
  )
);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "chat_events" WHERE "event_type" = 'goal.changed'
  ) THEN
    RAISE EXCEPTION 'Historical goal.changed rows remain';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "chat_events"
    WHERE "event_type" = 'output.followups'
      AND "recommended_followups" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Historical recommended_followups payloads remain';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND "tgenabled" <> 'D'
  ) THEN
    RAISE EXCEPTION 'chat_events append-only trigger must be enabled';
  END IF;
END;
$$;
