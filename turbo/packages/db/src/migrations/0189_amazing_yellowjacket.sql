ALTER TABLE "zero_agent_schedules" DROP CONSTRAINT "zero_agent_schedules_last_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD CONSTRAINT "zero_agent_schedules_last_run_id_agent_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;