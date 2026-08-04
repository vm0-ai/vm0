-- Convert invalidated goal continuations written by the draining API release
-- into payload-free revocations. Remove this bridge after every API version
-- older than the accompanying application change has drained.
CREATE FUNCTION "bridge_invalidated_goal_continuation_0828"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "queued_goal"
    WHERE "queued_goal"."id" = NEW."revokes_event_id"
      AND "queued_goal"."chat_thread_id" = NEW."chat_thread_id"
      AND "queued_goal"."event_type" = 'input.goal'
  ) THEN
    NEW."event_type" := 'control.revoke';
    NEW."content" := NULL;
    NEW."error" := NULL;
    NEW."user_message" := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_invalidated_goal_continuation_0828"
BEFORE INSERT ON "chat_events"
FOR EACH ROW
WHEN (
  NEW."event_type" = 'input.rejected'
  AND NEW."error" = 'Goal continuation no longer matches the active goal'
)
EXECUTE FUNCTION "bridge_invalidated_goal_continuation_0828"();--> statement-breakpoint

-- Preserve the immutable event stream by appending one control.revoke for
-- each legacy invalidation artifact instead of updating or deleting it.
DO $$
DECLARE
  candidate record;
  next_seq_id bigint;
BEGIN
  FOR candidate IN
    SELECT
      "rejected"."id",
      "rejected"."chat_thread_id",
      "rejected"."created_at"
    FROM "chat_events" AS "rejected"
    INNER JOIN "chat_events" AS "queued_goal"
      ON "queued_goal"."id" = "rejected"."revokes_event_id"
      AND "queued_goal"."chat_thread_id" = "rejected"."chat_thread_id"
    WHERE "rejected"."event_type" = 'input.rejected'
      AND "rejected"."error" = 'Goal continuation no longer matches the active goal'
      AND "queued_goal"."event_type" = 'input.goal'
      AND NOT EXISTS (
        SELECT 1
        FROM "chat_events" AS "revoker"
        WHERE "revoker"."revokes_event_id" = "rejected"."id"
      )
    ORDER BY "rejected"."chat_thread_id", "rejected"."id"
    FOR UPDATE OF "rejected"
  LOOP
    UPDATE "chat_threads"
    SET "last_chat_event_seq_id" = "last_chat_event_seq_id" + 1
    WHERE "id" = candidate."chat_thread_id"
    RETURNING "last_chat_event_seq_id" INTO next_seq_id;

    IF next_seq_id IS NULL THEN
      RAISE EXCEPTION 'Chat thread % not found', candidate."chat_thread_id";
    END IF;

    INSERT INTO "chat_events" (
      "id",
      "chat_thread_id",
      "run_id",
      "revokes_event_id",
      "event_type",
      "content",
      "error",
      "user_message",
      "seq_id",
      "created_at"
    ) VALUES (
      gen_random_uuid(),
      candidate."chat_thread_id",
      NULL,
      candidate."id",
      'control.revoke',
      NULL,
      NULL,
      NULL,
      next_seq_id,
      GREATEST(
        statement_timestamp()::timestamp,
        candidate."created_at" + interval '1 millisecond'
      )
    );
  END LOOP;
END;
$$;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "rejected"
    INNER JOIN "chat_events" AS "queued_goal"
      ON "queued_goal"."id" = "rejected"."revokes_event_id"
      AND "queued_goal"."chat_thread_id" = "rejected"."chat_thread_id"
    WHERE "rejected"."event_type" = 'input.rejected'
      AND "rejected"."error" = 'Goal continuation no longer matches the active goal'
      AND "queued_goal"."event_type" = 'input.goal'
      AND NOT EXISTS (
        SELECT 1
        FROM "chat_events" AS "revoker"
        WHERE "revoker"."revokes_event_id" = "rejected"."id"
      )
  ) THEN
    RAISE EXCEPTION 'Invalidated goal continuation artifacts remain visible';
  END IF;
END;
$$;
