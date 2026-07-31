-- Keep append-only protection installed while narrowly permitting this
-- migration to replace only the canonical user_message document.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND (to_jsonb(NEW) - 'user_message') = (to_jsonb(OLD) - 'user_message')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Match JavaScript encodeURIComponent for the Teams and GitHub message links
-- that previously were projected by chat-event-annotation.service.ts.
CREATE FUNCTION "encode_uri_component_0785"("value" text)
RETURNS text AS $$
DECLARE
  "bytes" bytea := convert_to("value", 'UTF8');
  "encoded" text := '';
  "index" integer;
  "octet" integer;
BEGIN
  IF length("bytes") = 0 THEN
    RETURN '';
  END IF;

  FOR "index" IN 0..length("bytes") - 1 LOOP
    "octet" := get_byte("bytes", "index");
    IF ("octet" BETWEEN 48 AND 57)
      OR ("octet" BETWEEN 65 AND 90)
      OR ("octet" BETWEEN 97 AND 122)
      OR "octet" IN (33, 39, 40, 41, 42, 45, 46, 95, 126)
    THEN
      "encoded" := "encoded" || chr("octet");
    ELSE
      "encoded" := "encoded" || '%' || upper(lpad(to_hex("octet"), 2, '0'));
    END IF;
  END LOOP;

  RETURN "encoded";
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;--> statement-breakpoint

WITH "source_parts" AS (
  SELECT
    "event"."id" AS "event_id",
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'source',
      'kind', 'slack',
      'href', NULLIF("context"."message_permalink", '')
    )) AS "part"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_slack_context" AS "context"
    ON "event"."context_type" = 'slack'
    AND "event"."context_id" = "context"."id"

  UNION ALL

  SELECT
    "event"."id" AS "event_id",
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'source',
      'kind', 'feishu',
      'href', NULLIF("context"."chat_open_url", '')
    )) AS "part"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_feishu_context" AS "context"
    ON "event"."context_type" = 'feishu'
    AND "event"."context_id" = "context"."id"

  UNION ALL

  SELECT
    "event"."id" AS "event_id",
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'source',
      'kind', 'teams',
      'href',
      CASE
        WHEN COALESCE("context"."channel_id", '') <> ''
          AND COALESCE("context"."activity_id", '') <> ''
          AND COALESCE("context"."tenant_id", '') <> ''
        THEN
          'https://teams.microsoft.com/l/message/'
          || "encode_uri_component_0785"("context"."channel_id")
          || '/'
          || "encode_uri_component_0785"("context"."activity_id")
          || '?tenantId='
          || "encode_uri_component_0785"("context"."tenant_id")
        ELSE NULL
      END
    )) AS "part"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_teams_context" AS "context"
    ON "event"."context_type" = 'teams'
    AND "event"."context_id" = "context"."id"

  UNION ALL

  SELECT
    "event"."id" AS "event_id",
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'source',
      'kind', 'telegram',
      'href',
      CASE
        WHEN "context"."is_dm" = false
          AND "context"."chat_id" LIKE '-100%'
          AND substring("context"."chat_id" FROM 5) ~ '^[1-9][0-9]*$'
          AND "context"."message_id" ~ '^[1-9][0-9]*$'
        THEN
          'https://t.me/c/'
          || substring("context"."chat_id" FROM 5)
          || '/'
          || "context"."message_id"
        ELSE NULL
      END
    )) AS "part"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_telegram_context" AS "context"
    ON "event"."context_type" = 'telegram'
    AND "event"."context_id" = "context"."id"

  UNION ALL

  SELECT
    "event"."id" AS "event_id",
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'source',
      'kind', 'github',
      'href',
      CASE
        WHEN cardinality(string_to_array("context"."repo", '/')) = 2
          AND split_part("context"."repo", '/', 1) <> ''
          AND split_part("context"."repo", '/', 2) <> ''
          AND "context"."subject_number" > 0
          AND (
            "context"."trigger_comment_id" IS NULL
            OR "context"."trigger_comment_id" ~ '^[1-9][0-9]*$'
          )
        THEN
          'https://github.com/'
          || "encode_uri_component_0785"(split_part("context"."repo", '/', 1))
          || '/'
          || "encode_uri_component_0785"(split_part("context"."repo", '/', 2))
          || '/'
          || CASE
            WHEN "context"."subject_kind" = 'pull_request' THEN 'pull'
            ELSE 'issues'
          END
          || '/'
          || "context"."subject_number"
          || CASE
            WHEN "context"."trigger_comment_id" IS NULL THEN ''
            ELSE '#issuecomment-' || "context"."trigger_comment_id"
          END
        ELSE NULL
      END
    )) AS "part"
  FROM "chat_events" AS "event"
  INNER JOIN "chat_github_context" AS "context"
    ON "event"."context_type" = 'github'
    AND "event"."context_id" = "context"."id"
)
UPDATE "chat_events" AS "event"
SET "user_message" = jsonb_set(
  "event"."user_message",
  '{parts}',
  ("event"."user_message" -> 'parts') || jsonb_build_array("source"."part")
)
FROM "source_parts" AS "source"
WHERE "event"."id" = "source"."event_id";--> statement-breakpoint

-- Claimed automation rows currently contain a copy of agent_runs.prompt.
-- Replace every carrier in the revoke chain with its display-only document;
-- agent_runs.prompt remains the authoritative prompt.
UPDATE "chat_events" AS "event"
SET "user_message" = jsonb_build_object(
  'version',
  1,
  'parts',
  jsonb_build_array(
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'automation',
      'workflowName', "workflow"."name",
      'workflowId', "workflow"."id",
      'automationBrief', "context"."trigger_brief"
    ))
  )
)
FROM "chat_automation_context" AS "context"
INNER JOIN "zero_workflow_automations" AS "automation"
  ON "automation"."id" = "context"."automation_id"
INNER JOIN "zero_workflows" AS "workflow"
  ON "workflow"."id" = "automation"."workflow_id"
WHERE "event"."context_type" = 'automation'
  AND "event"."context_id" = "context"."id";--> statement-breakpoint

-- Goal claims are handled the same way: the continuation prompt remains on
-- agent_runs while the event document carries only the user-visible brief.
UPDATE "chat_events" AS "event"
SET "user_message" = jsonb_build_object(
  'version',
  1,
  'parts',
  jsonb_build_array(jsonb_build_object(
    'type', 'goal',
    'goalBrief', "context"."objective_brief"
  ))
)
FROM "chat_goal_context" AS "context"
WHERE "event"."context_type" = 'goal'
  AND "event"."context_id" = "context"."id";--> statement-breakpoint

DROP FUNCTION "encode_uri_component_0785"(text);--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND "tgenabled" <> 'D'
      AND "tgfoid" = 'public.reject_chat_event_source_update()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'strict chat_events append-only trigger must remain enabled';
  END IF;
END;
$$;
