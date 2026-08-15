-- vm0:non-transactional
-- Relax the context constraints before current API writers start recording
-- table-less web and goal source discriminators, then classify historical
-- queued inputs in small transactions while normal traffic continues.

ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_pair_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_pair_check" CHECK ("chat_events"."context_id" IS NULL OR "chat_events"."context_type" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'web',
          'slack',
          'feishu',
          'teams',
          'telegram',
          'github',
          'agentphone',
          'automation',
          'goal',
          'morning_brief',
          'agent_run'
        ));--> statement-breakpoint

COMMENT ON COLUMN "chat_events"."context_type" IS
  'Input source discriminator; context_id points to a source context row when one exists. web and goal have no context row.';--> statement-breakpoint

CREATE OR REPLACE FUNCTION "chat_event_context_type_from_trigger_source_0836"(
  source_trigger text,
  source_event_type text
) RETURNS text AS $$
BEGIN
  CASE source_trigger
    WHEN 'web' THEN RETURN 'web';
    WHEN 'slack' THEN RETURN 'slack';
    WHEN 'feishu' THEN RETURN 'feishu';
    WHEN 'teams' THEN RETURN 'teams';
    WHEN 'telegram' THEN RETURN 'telegram';
    WHEN 'github' THEN RETURN 'github';
    WHEN 'agentphone' THEN RETURN 'agentphone';
    WHEN 'agent' THEN RETURN 'agent_run';
    WHEN 'workflow-event' THEN RETURN 'automation';
    WHEN 'workflow-schedule' THEN
      IF source_event_type = 'input.automation' THEN
        RETURN 'automation';
      END IF;
      RETURN 'morning_brief';
    ELSE
      RAISE EXCEPTION 'Unsupported chat event trigger source: %', source_trigger;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND "tgenabled" <> 'D'
  ) THEN
    RAISE EXCEPTION 'chat_events append-only trigger must be enabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "candidate"
    LEFT JOIN "zero_runs" AS "own_run"
      ON "own_run"."id" = "candidate"."run_id"
    LEFT JOIN "chat_events" AS "revoker"
      ON "revoker"."revokes_event_id" = "candidate"."id"
    LEFT JOIN "zero_runs" AS "revoker_run"
      ON "revoker_run"."id" = "revoker"."run_id"
    WHERE "candidate"."context_type" IS NULL
      AND "candidate"."event_type" IN (
        'input.prompt',
        'input.automation',
        'input.goal'
      )
      AND "candidate"."event_type" <> 'input.goal'
      AND COALESCE(
        "candidate"."trigger_source",
        "own_run"."trigger_source",
        "revoker_run"."trigger_source"
      ) IS NOT NULL
      AND COALESCE(
        "candidate"."trigger_source",
        "own_run"."trigger_source",
        "revoker_run"."trigger_source"
      ) NOT IN (
        'web',
        'slack',
        'feishu',
        'teams',
        'telegram',
        'github',
        'agentphone',
        'agent',
        'workflow-event',
        'workflow-schedule'
      )
  ) THEN
    RAISE EXCEPTION 'Covered chat_events contain an unsupported trigger source';
  END IF;
END;
$$;--> statement-breakpoint

-- Keep append-only protection installed while narrowly permitting only the
-- expected context discriminator to be filled. Every other column remains
-- byte-identical, and context_id remains null for these historical rows.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
DECLARE
  expected_context_type text;
  source_trigger text;
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."context_type" IS NULL
    AND OLD."context_id" IS NULL
    AND NEW."context_type" IS NOT NULL
    AND NEW."context_id" IS NULL
    AND OLD."event_type" IN (
      'input.prompt',
      'input.automation',
      'input.goal'
    )
    AND (to_jsonb(NEW) - 'context_type' - 'context_id')
      = (to_jsonb(OLD) - 'context_type' - 'context_id')
  THEN
    SELECT COALESCE(
      OLD."trigger_source",
      "own_run"."trigger_source",
      "revoker_run"."trigger_source"
    )
    INTO source_trigger
    FROM (VALUES (1)) AS "anchor"("value")
    LEFT JOIN "zero_runs" AS "own_run"
      ON "own_run"."id" = OLD."run_id"
    LEFT JOIN "chat_events" AS "revoker"
      ON "revoker"."revokes_event_id" = OLD."id"
    LEFT JOIN "zero_runs" AS "revoker_run"
      ON "revoker_run"."id" = "revoker"."run_id";

    expected_context_type := CASE
      WHEN OLD."event_type" = 'input.goal' THEN 'goal'
      ELSE COALESCE(
        "chat_event_context_type_from_trigger_source_0836"(
          source_trigger,
          OLD."event_type"
        ),
        'web'
      )
    END;

    IF NEW."context_type" = expected_context_type THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "backfill_chat_event_context_types_0836"()
LANGUAGE plpgsql AS $$
DECLARE
  batch_last_id uuid;
  last_id uuid;
BEGIN
  LOOP
    batch_last_id := NULL;

    WITH batch AS (
      SELECT
        "candidate"."id",
        CASE
          WHEN "candidate"."event_type" = 'input.goal' THEN 'goal'
          ELSE COALESCE(
            "chat_event_context_type_from_trigger_source_0836"(
              COALESCE(
                "candidate"."trigger_source",
                "own_run"."trigger_source",
                "revoker_run"."trigger_source"
              ),
              "candidate"."event_type"
            ),
            'web'
          )
        END AS "context_type"
      FROM "chat_events" AS "candidate"
      LEFT JOIN "zero_runs" AS "own_run"
        ON "own_run"."id" = "candidate"."run_id"
      LEFT JOIN "chat_events" AS "revoker"
        ON "revoker"."revokes_event_id" = "candidate"."id"
      LEFT JOIN "zero_runs" AS "revoker_run"
        ON "revoker_run"."id" = "revoker"."run_id"
      WHERE (last_id IS NULL OR "candidate"."id" > last_id)
        AND "candidate"."context_type" IS NULL
        AND "candidate"."event_type" IN (
          'input.prompt',
          'input.automation',
          'input.goal'
        )
      ORDER BY "candidate"."id"
      LIMIT 10000
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "chat_events" AS "target"
      SET "context_type" = batch."context_type"
      FROM batch
      WHERE "target"."id" = batch."id"
      RETURNING "target"."id"
    )
    SELECT "updated"."id"
    INTO batch_last_id
    FROM updated
    ORDER BY "updated"."id" DESC
    LIMIT 1;

    COMMIT;
    EXIT WHEN batch_last_id IS NULL;
    last_id := batch_last_id;
  END LOOP;
END;
$$;--> statement-breakpoint

-- The final fallback covers only revoked rows. Production measurement found
-- 2,613 control.revoke revokers whose chat-send paths prove a web source. The
-- other 52 revokers are input.rejected rows with unrecoverable provenance;
-- they receive web only as a harmless placeholder because they never dispatch.
CALL "backfill_chat_event_context_types_0836"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_chat_event_context_types_0836"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP FUNCTION IF EXISTS "chat_event_context_type_from_trigger_source_0836"(text, text);--> statement-breakpoint

DO $$
DECLARE
  rule_five_slack_rows bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events"
    WHERE "event_type" IN (
      'input.prompt',
      'input.automation',
      'input.goal'
    )
      AND "context_type" IS NULL
  ) THEN
    RAISE EXCEPTION 'Covered chat_events still lack context_type';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "event"
    INNER JOIN "chat_events" AS "revoker"
      ON "revoker"."revokes_event_id" = "event"."id"
    INNER JOIN "zero_runs" AS "revoker_run"
      ON "revoker_run"."id" = "revoker"."run_id"
    WHERE "event"."event_type" IN ('input.prompt', 'input.automation')
      AND "event"."trigger_source" IS NULL
      AND "event"."run_id" IS NULL
      AND "event"."context_id" IS NULL
      AND "revoker_run"."trigger_source" = 'slack'
      AND "event"."context_type" <> 'slack'
  ) THEN
    RAISE EXCEPTION 'Rule 5 Slack chat_events were misclassified';
  END IF;

  SELECT count(*)
  INTO rule_five_slack_rows
  FROM "chat_events" AS "event"
  INNER JOIN "chat_events" AS "revoker"
    ON "revoker"."revokes_event_id" = "event"."id"
  INNER JOIN "zero_runs" AS "revoker_run"
    ON "revoker_run"."id" = "revoker"."run_id"
  WHERE "event"."event_type" IN ('input.prompt', 'input.automation')
    AND "event"."trigger_source" IS NULL
    AND "event"."run_id" IS NULL
    AND "event"."context_type" = 'slack'
    AND "event"."context_id" IS NULL
    AND "revoker_run"."trigger_source" = 'slack';

  RAISE NOTICE 'Rule 5 Slack rows after backfill: %', rule_five_slack_rows;
END;
$$;
