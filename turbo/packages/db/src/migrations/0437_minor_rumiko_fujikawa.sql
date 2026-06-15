ALTER TABLE "chat_messages" ADD COLUMN "schedule_snapshot" jsonb;

UPDATE "chat_messages" AS cm
SET "schedule_snapshot" = jsonb_build_object(
  'id', zas."id"::text,
  'title', COALESCE(cm."schedule_title", zas."name"),
  'description', zas."description"
)
FROM "zero_agent_schedules" AS zas
WHERE cm."schedule_snapshot" IS NULL
  AND cm."schedule_id" IS NOT NULL
  AND cm."schedule_id" = zas."id";
