-- Re-run the idempotent goal-context backfill before dropping the legacy
-- column so rows written by an overlapping pre-cutover API are covered.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND (to_jsonb(NEW) - 'context_type' - 'context_id')
      = (to_jsonb(OLD) - 'context_type' - 'context_id')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

INSERT INTO "chat_goal_context" (
  "id",
  "chat_thread_id",
  "objective_brief",
  "created_at"
)
SELECT
  "event"."id",
  "event"."chat_thread_id",
  "event"."goal_snapshot" ->> 'objectiveBrief',
  "event"."created_at"
FROM "chat_events" AS "event"
WHERE "event"."goal_snapshot" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "chat_events" AS "predecessor"
    WHERE "predecessor"."id" = "event"."revokes_event_id"
      AND "predecessor"."goal_snapshot" IS NOT NULL
  )
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

UPDATE "chat_events" AS "event"
SET
  "context_type" = 'goal',
  "context_id" = "context"."id"
FROM "chat_goal_context" AS "context"
WHERE "event"."id" = "context"."id"
  AND "event"."goal_snapshot" IS NOT NULL;--> statement-breakpoint

WITH RECURSIVE "goal_context_chain" AS (
  SELECT
    "event"."id" AS "event_id",
    "context"."id" AS "context_id",
    0 AS "depth"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_goal_context" AS "context"
    ON "context"."id" = "event"."id"
  WHERE "event"."goal_snapshot" IS NOT NULL

  UNION ALL

  SELECT
    "replacement"."id" AS "event_id",
    "chain"."context_id",
    "chain"."depth" + 1
  FROM "chat_events" AS "replacement"
  INNER JOIN "goal_context_chain" AS "chain"
    ON "replacement"."revokes_event_id" = "chain"."event_id"
),
"resolved_goal_context" AS (
  SELECT DISTINCT ON ("event_id")
    "event_id",
    "context_id"
  FROM "goal_context_chain"
  ORDER BY "event_id", "depth"
)
UPDATE "chat_events" AS "event"
SET
  "context_type" = 'goal',
  "context_id" = "resolved"."context_id"
FROM "resolved_goal_context" AS "resolved"
WHERE "event"."id" = "resolved"."event_id";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

ALTER TABLE "chat_events" DROP COLUMN "goal_snapshot";
