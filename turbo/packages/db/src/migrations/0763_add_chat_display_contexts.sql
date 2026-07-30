CREATE TABLE "chat_feishu_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"chat_open_url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_slack_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"message_permalink" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_feishu_context" ADD CONSTRAINT "chat_feishu_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD CONSTRAINT "chat_slack_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

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

INSERT INTO "chat_slack_context" (
  "id",
  "chat_thread_id",
  "message_permalink",
  "created_at"
)
SELECT
  "id",
  "chat_thread_id",
  "slack_message_permalink",
  "created_at"
FROM "chat_events"
WHERE "slack_message_permalink" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

UPDATE "chat_events" AS "event"
SET
  "context_type" = 'slack',
  "context_id" = "context"."id"
FROM "chat_slack_context" AS "context"
WHERE "event"."id" = "context"."id"
  AND "event"."slack_message_permalink" IS NOT NULL;--> statement-breakpoint

WITH RECURSIVE "slack_context_chain" AS (
  SELECT
    "event"."id" AS "event_id",
    "context"."id" AS "context_id",
    0 AS "depth"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_slack_context" AS "context"
    ON "context"."id" = "event"."id"
  WHERE "event"."slack_message_permalink" IS NOT NULL

  UNION ALL

  SELECT
    "replacement"."id" AS "event_id",
    "chain"."context_id",
    "chain"."depth" + 1
  FROM "chat_events" AS "replacement"
  INNER JOIN "slack_context_chain" AS "chain"
    ON "replacement"."revokes_message_id" = "chain"."event_id"
),
"resolved_slack_context" AS (
  SELECT DISTINCT ON ("event_id")
    "event_id",
    "context_id"
  FROM "slack_context_chain"
  ORDER BY "event_id", "depth"
)
UPDATE "chat_events" AS "event"
SET
  "context_type" = 'slack',
  "context_id" = "resolved"."context_id"
FROM "resolved_slack_context" AS "resolved"
WHERE "event"."id" = "resolved"."event_id";--> statement-breakpoint

INSERT INTO "chat_feishu_context" (
  "id",
  "chat_thread_id",
  "chat_open_url",
  "created_at"
)
SELECT
  "id",
  "chat_thread_id",
  "feishu_chat_open_url",
  "created_at"
FROM "chat_events"
WHERE "feishu_chat_open_url" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

UPDATE "chat_events" AS "event"
SET
  "context_type" = 'feishu',
  "context_id" = "context"."id"
FROM "chat_feishu_context" AS "context"
WHERE "event"."id" = "context"."id"
  AND "event"."feishu_chat_open_url" IS NOT NULL;--> statement-breakpoint

WITH RECURSIVE "feishu_context_chain" AS (
  SELECT
    "event"."id" AS "event_id",
    "context"."id" AS "context_id",
    0 AS "depth"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_feishu_context" AS "context"
    ON "context"."id" = "event"."id"
  WHERE "event"."feishu_chat_open_url" IS NOT NULL

  UNION ALL

  SELECT
    "replacement"."id" AS "event_id",
    "chain"."context_id",
    "chain"."depth" + 1
  FROM "chat_events" AS "replacement"
  INNER JOIN "feishu_context_chain" AS "chain"
    ON "replacement"."revokes_message_id" = "chain"."event_id"
),
"resolved_feishu_context" AS (
  SELECT DISTINCT ON ("event_id")
    "event_id",
    "context_id"
  FROM "feishu_context_chain"
  ORDER BY "event_id", "depth"
)
UPDATE "chat_events" AS "event"
SET
  "context_type" = 'feishu',
  "context_id" = "resolved"."context_id"
FROM "resolved_feishu_context" AS "resolved"
WHERE "event"."id" = "resolved"."event_id";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
