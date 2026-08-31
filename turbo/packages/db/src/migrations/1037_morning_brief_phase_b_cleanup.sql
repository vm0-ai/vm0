-- P8 Phase B terminally removes the retired bespoke Morning Brief pipeline.
-- Phase A's barriers stay installed until the dormant state and exact
-- historical Chat shape have both been revalidated below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "org_members_metadata"
    WHERE "morning_brief_enabled"
  ) THEN
    RAISE EXCEPTION 'Morning Brief preferences were not terminalized';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "morning_brief_schedules"
    WHERE "next_run_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Morning Brief schedules are still due';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "morning_brief_deliveries"
    WHERE "status" NOT IN ('emailed', 'failed', 'skipped')
  ) THEN
    RAISE EXCEPTION 'Morning Brief deliveries are not terminal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_run_callbacks"
    WHERE "internal_kind" = 'morning-brief:email'
      AND "status" <> 'delivered'
  ) THEN
    RAISE EXCEPTION 'Morning Brief callbacks are not terminal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "email_outbox"
    WHERE "status" <> 'sent'
  ) THEN
    RAISE EXCEPTION 'Email outbox contains unsent work';
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
--> statement-breakpoint
UPDATE "org_members_metadata"
SET "morning_brief_enabled" = false
WHERE "morning_brief_enabled" IS DISTINCT FROM false;
--> statement-breakpoint
UPDATE "morning_brief_schedules"
SET "next_run_at" = NULL
WHERE "next_run_at" IS NOT NULL;
--> statement-breakpoint

-- Every historical context was created with one run-less source prompt whose
-- id is the context id. Exactly one immutable replacement then terminalized it:
-- either a Run-attributed prompt or a rejected prompt appended by the Phase A
-- drain fallback. Reject any other shape before changing a discriminator.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_morning_brief_context" AS "context"
    LEFT JOIN "morning_brief_deliveries" AS "delivery"
      ON "delivery"."id" = "context"."delivery_id"
    WHERE "delivery"."id" IS NULL
      OR "delivery"."status" NOT IN ('emailed', 'failed', 'skipped')
  ) THEN
    RAISE EXCEPTION 'Morning Brief context is missing a terminal delivery';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_morning_brief_context" AS "context"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "chat_events" AS "source"
      WHERE "source"."id" = "context"."id"
        AND "source"."chat_thread_id" = "context"."chat_thread_id"
        AND "source"."event_type" = 'input.prompt'
        AND "source"."run_id" IS NULL
        AND "source"."revokes_event_id" IS NULL
        AND "source"."context_type" = 'morning_brief'
        AND "source"."context_id" = "context"."id"
    )
  ) THEN
    RAISE EXCEPTION 'Morning Brief context is missing its source prompt';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_morning_brief_context" AS "context"
    WHERE (
      SELECT count(*)
      FROM "chat_events" AS "event"
      WHERE "event"."chat_thread_id" = "context"."chat_thread_id"
        AND "event"."context_type" = 'morning_brief'
        AND "event"."context_id" = "context"."id"
    ) <> 2
      OR (
        SELECT count(*)
        FROM "chat_events" AS "replacement"
        WHERE "replacement"."chat_thread_id" = "context"."chat_thread_id"
          AND "replacement"."context_type" = 'morning_brief'
          AND "replacement"."context_id" = "context"."id"
          AND "replacement"."revokes_event_id" = "context"."id"
          AND (
            (
              "replacement"."event_type" = 'input.prompt'
              AND "replacement"."run_id" IS NOT NULL
            )
            OR (
              "replacement"."event_type" = 'input.rejected'
              AND "replacement"."run_id" IS NULL
            )
          )
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'Morning Brief context does not have one terminal replacement';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "event"
    LEFT JOIN "chat_morning_brief_context" AS "context"
      ON "context"."id" = "event"."context_id"
      AND "context"."chat_thread_id" = "event"."chat_thread_id"
    LEFT JOIN "morning_brief_deliveries" AS "delivery"
      ON "delivery"."id" = "context"."delivery_id"
    WHERE "event"."context_type" = 'morning_brief'
      AND (
        "context"."id" IS NULL
        OR "event"."event_type" NOT IN ('input.prompt', 'input.rejected')
        OR "event"."required_official_workflow_ids" IS NOT NULL
        OR "event"."payload" IS NULL
        OR jsonb_typeof("event"."payload" -> 'userMessage') <> 'object'
        OR "event"."payload" -> 'userMessage' -> 'version' <> '1'::jsonb
        OR jsonb_typeof("event"."payload" -> 'userMessage' -> 'parts') <> 'array'
        OR (
          SELECT count(*)
          FROM jsonb_array_elements(
            "event"."payload" -> 'userMessage' -> 'parts'
          ) AS "part"
          WHERE "part" ->> 'type' = 'morning_brief'
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            "event"."payload" -> 'userMessage' -> 'parts'
          ) AS "part"
          WHERE "part" = jsonb_build_object(
            'type', 'morning_brief',
            'briefDate', "delivery"."brief_date"
          )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            "event"."payload" -> 'userMessage' -> 'parts'
          ) AS "part"
          WHERE "part" ->> 'type' <> 'morning_brief'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Morning Brief event document has an unexpected historical shape';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "event"
    WHERE "event"."context_type" IS DISTINCT FROM 'morning_brief'
      AND jsonb_typeof("event"."payload" -> 'userMessage' -> 'parts') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          "event"."payload" -> 'userMessage' -> 'parts'
        ) AS "part"
        WHERE "part" ->> 'type' = 'morning_brief'
      )
  ) THEN
    RAISE EXCEPTION 'Morning Brief document marker exists outside its legacy context';
  END IF;
END;
$$;
--> statement-breakpoint

-- Keep the append-only trigger installed while allowing only the exact
-- context neutralization and one-part document cleanup asserted above.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
DECLARE
  expected_payload jsonb;
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."context_type" = 'morning_brief'
    AND OLD."context_id" IS NOT NULL
    AND OLD."event_type" IN ('input.prompt', 'input.rejected')
    AND NEW."context_type" = 'web'
    AND NEW."context_id" IS NULL
    AND (
      to_jsonb(NEW) - 'payload' - 'context_type' - 'context_id'
    ) = (
      to_jsonb(OLD) - 'payload' - 'context_type' - 'context_id'
    )
  THEN
    SELECT jsonb_set(
      OLD."payload",
      '{userMessage,parts}',
      jsonb_agg("part" ORDER BY "ordinality")
        FILTER (WHERE "part" ->> 'type' <> 'morning_brief'),
      false
    )
    INTO expected_payload
    FROM jsonb_array_elements(
      OLD."payload" -> 'userMessage' -> 'parts'
    ) WITH ORDINALITY AS "parts"("part", "ordinality");

    IF NEW."payload" = expected_payload THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
UPDATE "chat_events" AS "event"
SET
  "payload" = jsonb_set(
    "event"."payload",
    '{userMessage,parts}',
    (
      SELECT jsonb_agg("part" ORDER BY "ordinality")
      FROM jsonb_array_elements(
        "event"."payload" -> 'userMessage' -> 'parts'
      ) WITH ORDINALITY AS "parts"("part", "ordinality")
      WHERE "part" ->> 'type' <> 'morning_brief'
    ),
    false
  ),
  "context_type" = 'web',
  "context_id" = NULL
WHERE "event"."context_type" = 'morning_brief';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Re-prove that every migrated source is revoked and therefore excluded from
-- pending queue/admission even after the bespoke queue predicate is removed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_morning_brief_context" AS "context"
    INNER JOIN "chat_events" AS "event"
      ON "event"."chat_thread_id" = "context"."chat_thread_id"
      AND (
        "event"."id" = "context"."id"
        OR "event"."revokes_event_id" = "context"."id"
      )
    WHERE "event"."context_type" <> 'web'
      OR "event"."context_id" IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          "event"."payload" -> 'userMessage' -> 'parts'
        ) AS "part"
        WHERE "part" ->> 'type' = 'morning_brief'
      )
  ) THEN
    RAISE EXCEPTION 'Morning Brief Chat history was not fully neutralized';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_morning_brief_context" AS "context"
    INNER JOIN "chat_events" AS "source"
      ON "source"."id" = "context"."id"
      AND "source"."chat_thread_id" = "context"."chat_thread_id"
    WHERE "source"."event_type" = 'input.prompt'
      AND "source"."run_id" IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "chat_events" AS "revoker"
        WHERE "revoker"."revokes_event_id" = "source"."id"
      )
  ) THEN
    RAISE EXCEPTION 'A migrated Morning Brief prompt can re-enter the queue';
  END IF;
END;
$$;
--> statement-breakpoint

-- Delivered callbacks retain their Run association but lose the retired
-- dispatch identity and delivery payload. Sent outbox bookkeeping for the
-- removed renderer can be discarded without changing the delivered email.
UPDATE "agent_run_callbacks"
SET
  "internal_kind" = NULL,
  "payload" = NULL
WHERE "internal_kind" = 'morning-brief:email';
--> statement-breakpoint
DELETE FROM "email_outbox"
WHERE "template" ->> 'template' = 'morning-brief';
--> statement-breakpoint

ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";
--> statement-breakpoint
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
  'agent_run'
));
--> statement-breakpoint

DROP TRIGGER IF EXISTS "force_legacy_morning_brief_disabled_1029" ON "org_members_metadata";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pause_legacy_morning_brief_schedule_1029" ON "morning_brief_schedules";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reject_legacy_morning_brief_delivery_1029" ON "morning_brief_deliveries";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reject_legacy_morning_brief_context_1029" ON "chat_morning_brief_context";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reject_legacy_morning_brief_email_1029" ON "email_outbox";
--> statement-breakpoint

DROP FUNCTION IF EXISTS "force_legacy_morning_brief_disabled_1029"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "pause_legacy_morning_brief_schedule_1029"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "reject_legacy_morning_brief_delivery_1029"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "reject_legacy_morning_brief_context_1029"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "reject_legacy_morning_brief_email_1029"();
--> statement-breakpoint

ALTER TABLE "chat_morning_brief_context" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "morning_brief_deliveries" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "morning_brief_schedules" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TABLE "chat_morning_brief_context" CASCADE;
--> statement-breakpoint
DROP TABLE "morning_brief_deliveries" CASCADE;
--> statement-breakpoint
DROP TABLE "morning_brief_schedules" CASCADE;
--> statement-breakpoint
ALTER TABLE "org_members_metadata" DROP COLUMN "morning_brief_enabled";
