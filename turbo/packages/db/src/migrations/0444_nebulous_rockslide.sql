ALTER TABLE "automations" ADD COLUMN "append_system_prompt" text;--> statement-breakpoint
-- Carry append_system_prompt into already-mirrored automations (the 0442
-- backfill and the dual-write predate the column). Idempotent data-only copy;
-- unmirrored automations (no source_schedule_id) are untouched.
UPDATE "automations" AS "automation"
SET "append_system_prompt" = "schedule"."append_system_prompt"
FROM "zero_agent_schedules" AS "schedule"
WHERE "automation"."source_schedule_id" = "schedule"."id"
  AND "schedule"."append_system_prompt" IS NOT NULL;
