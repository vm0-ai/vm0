-- vm0:non-transactional
-- The deployed writer already dual-writes payload, so install and validate the
-- canonical checks before removing their legacy-column predecessors. Each
-- constraint addition is restart-safe for the non-transactional runner.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'chat_events_input_user_message_payload_check'
      AND "conrelid" = 'public.chat_events'::regclass
  ) THEN
    ALTER TABLE "chat_events"
      ADD CONSTRAINT "chat_events_input_user_message_payload_check"
      CHECK (
        "event_type" NOT IN ('input.prompt', 'input.budget', 'input.rejected')
        OR (
          "payload" IS NOT NULL
          AND "payload" ? 'userMessage'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'chat_events_input_payload_content_check'
      AND "conrelid" = 'public.chat_events'::regclass
  ) THEN
    ALTER TABLE "chat_events"
      ADD CONSTRAINT "chat_events_input_payload_content_check"
      CHECK (
        "event_type" NOT IN ('input.prompt', 'input.budget', 'input.rejected')
        OR "payload" IS NULL
        OR NOT ("payload" ? 'content')
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'chat_events_goal_open_payload_check'
      AND "conrelid" = 'public.chat_events'::regclass
  ) THEN
    ALTER TABLE "chat_events"
      ADD CONSTRAINT "chat_events_goal_open_payload_check"
      CHECK (
        "event_type" <> 'goal.open'
        OR (
          "payload" IS NOT NULL
          AND "payload" ? 'content'
          AND jsonb_typeof("payload" -> 'content') = 'string'
          AND "payload" ->> 'content' = btrim("payload" ->> 'content')
          AND char_length("payload" ->> 'content') > 0
          AND "payload" - 'content' = '{}'::jsonb
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'chat_events_goal_close_payload_check'
      AND "conrelid" = 'public.chat_events'::regclass
  ) THEN
    ALTER TABLE "chat_events"
      ADD CONSTRAINT "chat_events_goal_close_payload_check"
      CHECK (
        "event_type" <> 'goal.close'
        OR "payload" IS NULL
      ) NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "chat_events"
  VALIDATE CONSTRAINT "chat_events_input_user_message_payload_check";
--> statement-breakpoint
ALTER TABLE "chat_events"
  VALIDATE CONSTRAINT "chat_events_input_payload_content_check";
--> statement-breakpoint
ALTER TABLE "chat_events"
  VALIDATE CONSTRAINT "chat_events_goal_open_payload_check";
--> statement-breakpoint
ALTER TABLE "chat_events"
  VALIDATE CONSTRAINT "chat_events_goal_close_payload_check";
--> statement-breakpoint
-- Concurrent index builds can leave an invalid index after interruption.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_output_thinking_run_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_output_thinking_run_id_unique"
  ON "chat_events" USING btree ("run_id")
  WHERE "event_type" = 'output.thinking' AND "run_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_events"
  DROP CONSTRAINT IF EXISTS "chat_events_input_user_message_check",
  DROP CONSTRAINT IF EXISTS "chat_events_input_content_check",
  DROP CONSTRAINT IF EXISTS "chat_events_goal_open_content_check",
  DROP CONSTRAINT IF EXISTS "chat_events_goal_close_content_check";
