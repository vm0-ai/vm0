-- Add foreign key constraint on agent_runs.schedule_id
-- References agent_schedules.id with ON DELETE SET NULL behavior
ALTER TABLE "agent_runs"
ADD CONSTRAINT "agent_runs_schedule_id_agent_schedules_id_fk"
FOREIGN KEY ("schedule_id") REFERENCES "agent_schedules"("id")
ON DELETE SET NULL;
