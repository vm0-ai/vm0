CREATE TABLE "chat_automation_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"trigger_brief" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_automation_context" ADD CONSTRAINT "chat_automation_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_automation_context_automation_id_idx" ON "chat_automation_context" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "chat_events_input_automation_context_idx" ON "chat_events" USING btree ("context_id") WHERE "chat_events"."event_type" = 'input.automation';--> statement-breakpoint

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
    ON "replacement"."revokes_message_id" = "chain"."event_id"
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
$$ LANGUAGE plpgsql;
