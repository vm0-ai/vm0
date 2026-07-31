CREATE TABLE "chat_goal_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"objective_brief" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_goal_context" ADD CONSTRAINT "chat_goal_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Keep append-only protection installed while allowing only the context
-- pointer backfill required by this migration.
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

-- goal_snapshot is copied onto replacements, unlike the earlier display
-- contexts. Create one context only for the earliest carrier in each revoke
-- chain, then propagate its pointer to every replacement below.
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
$$ LANGUAGE plpgsql;
