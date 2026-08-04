ALTER TABLE "zero_runs" DROP CONSTRAINT "zero_runs_trigger_agent_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "trigger_agent_id";