WITH standalone_followups AS (
  SELECT
    "id",
    "run_id",
    "recommended_followups",
    row_number() OVER (
      PARTITION BY "run_id"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS "rank"
  FROM "chat_messages"
  WHERE "role" = 'assistant'
    AND "run_id" IS NOT NULL
    AND "run_lifecycle_event" IS NULL
    AND "content" IS NULL
    AND "error" IS NULL
    AND "sequence_number" IS NULL
    AND "recommended_followups" IS NOT NULL
    AND jsonb_typeof("recommended_followups") = 'array'
    AND "recommended_followups" <> '[]'::jsonb
),
latest_followups AS (
  SELECT
    "run_id",
    "recommended_followups"
  FROM standalone_followups
  WHERE "rank" = 1
)
UPDATE "chat_messages" AS marker
SET "recommended_followups" = latest_followups."recommended_followups"
FROM latest_followups
WHERE marker."run_id" = latest_followups."run_id"
  AND marker."role" = 'assistant'
  AND marker."run_lifecycle_event" = 'completed'
  AND (
    marker."recommended_followups" IS NULL
    OR marker."recommended_followups" = '[]'::jsonb
  );--> statement-breakpoint

DELETE FROM "chat_messages" AS followups
USING "chat_messages" AS marker
WHERE followups."role" = 'assistant'
  AND followups."run_id" IS NOT NULL
  AND followups."run_lifecycle_event" IS NULL
  AND followups."content" IS NULL
  AND followups."error" IS NULL
  AND followups."sequence_number" IS NULL
  AND followups."recommended_followups" IS NOT NULL
  AND marker."run_id" = followups."run_id"
  AND marker."role" = 'assistant'
  AND marker."run_lifecycle_event" = 'completed';--> statement-breakpoint

UPDATE "chat_messages" AS message
SET
  "content" = agent_runs."error",
  "error" = agent_runs."error"
FROM "agent_runs"
WHERE message."run_id" = agent_runs."id"
  AND message."role" = 'assistant'
  AND message."run_lifecycle_event" IS NULL
  AND message."content" IS NULL
  AND message."error" IS NULL
  AND message."sequence_number" IS NULL
  AND message."revokes_message_id" IS NULL
  AND message."interrupts_run_id" IS NULL
  AND message."run_event_id" IS NULL
  AND message."recommended_followups" IS NULL
  AND agent_runs."error" IS NOT NULL
  AND btrim(agent_runs."error") <> '';
