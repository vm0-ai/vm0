ALTER TABLE "agent_run_events" DROP CONSTRAINT "agent_runtime_events_runtime_id_agent_runtimes_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;