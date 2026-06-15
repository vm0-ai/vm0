ALTER TABLE "checkpoints" DROP CONSTRAINT "checkpoints_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;