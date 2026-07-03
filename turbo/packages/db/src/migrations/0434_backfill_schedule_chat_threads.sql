WITH legacy_schedules AS MATERIALIZED (
  SELECT
    "id" AS "schedule_id",
    gen_random_uuid() AS "thread_id",
    "user_id",
    "agent_id",
    COALESCE("description", "name") AS "title"
  FROM "zero_agent_schedules"
  WHERE "chat_thread_id" IS NULL
  FOR UPDATE
),
inserted_threads AS (
  INSERT INTO "chat_threads" (
    "id",
    "user_id",
    "agent_compose_id",
    "title"
  )
  SELECT
    "thread_id",
    "user_id",
    "agent_id",
    "title"
  FROM legacy_schedules
  RETURNING "id"
)
UPDATE "zero_agent_schedules" AS "schedule"
SET
  "chat_thread_id" = legacy_schedules."thread_id",
  "updated_at" = now()
FROM legacy_schedules
JOIN inserted_threads
  ON inserted_threads."id" = legacy_schedules."thread_id"
WHERE "schedule"."id" = legacy_schedules."schedule_id"
  AND "schedule"."chat_thread_id" IS NULL;
