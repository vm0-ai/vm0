ALTER TABLE "credit_usage" DROP CONSTRAINT "credit_usage_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_usage" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_usage" ADD CONSTRAINT "credit_usage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;