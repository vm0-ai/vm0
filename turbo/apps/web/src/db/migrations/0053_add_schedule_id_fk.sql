-- Add foreign key constraint on agent_runs.schedule_id
-- References agent_schedules.id with ON DELETE SET NULL behavior

-- First, clean up any orphaned schedule_ids that don't exist in agent_schedules
UPDATE "agent_runs"
SET "schedule_id" = NULL
WHERE "schedule_id" IS NOT NULL
  AND "schedule_id" NOT IN (SELECT "id" FROM "agent_schedules");

-- Now add the FK constraint
ALTER TABLE "agent_runs"
ADD CONSTRAINT "agent_runs_schedule_id_agent_schedules_id_fk"
FOREIGN KEY ("schedule_id") REFERENCES "agent_schedules"("id")
ON DELETE SET NULL;
