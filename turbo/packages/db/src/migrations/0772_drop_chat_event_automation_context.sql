-- Catch up rows written by the previous deployment before removing the
-- legacy automation identity columns.
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

INSERT INTO "chat_automation_context" (
  "id",
  "chat_thread_id",
  "automation_id",
  "trigger_brief",
  "created_at"
)
SELECT
  "id",
  "chat_thread_id",
  "automation_id",
  "trigger_brief",
  "created_at"
FROM "chat_events"
WHERE "automation_id" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

UPDATE "chat_events" AS "event"
SET
  "context_type" = 'automation',
  "context_id" = "context"."id"
FROM "chat_automation_context" AS "context"
WHERE "event"."id" = "context"."id"
  AND "event"."automation_id" IS NOT NULL;--> statement-breakpoint

-- Migration 0768 contracted the revocation compatibility columns, so the
-- catch-up traversal uses their canonical revokes_event_id replacement.
WITH RECURSIVE "automation_context_chain" AS (
  SELECT
    "event"."id" AS "event_id",
    "context"."id" AS "context_id",
    0 AS "depth"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_automation_context" AS "context"
    ON "context"."id" = "event"."id"
  WHERE "event"."automation_id" IS NOT NULL

  UNION ALL

  SELECT
    "replacement"."id" AS "event_id",
    "chain"."context_id",
    "chain"."depth" + 1
  FROM "chat_events" AS "replacement"
  INNER JOIN "automation_context_chain" AS "chain"
    ON "replacement"."revokes_event_id" = "chain"."event_id"
),
"resolved_automation_context" AS (
  SELECT DISTINCT ON ("event_id")
    "event_id",
    "context_id"
  FROM "automation_context_chain"
  ORDER BY "event_id", "depth"
)
UPDATE "chat_events" AS "event"
SET
  "context_type" = 'automation',
  "context_id" = "resolved"."context_id"
FROM "resolved_automation_context" AS "resolved"
WHERE "event"."id" = "resolved"."event_id";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP INDEX "chat_events_input_automation_idx";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "automation_id";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "trigger_brief";
