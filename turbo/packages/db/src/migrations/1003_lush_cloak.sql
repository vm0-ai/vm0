CREATE TABLE "runner_job_claim_recovery" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"reuse_key" varchar(263),
	"execution_context" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runner_job_claim_recovery" ADD CONSTRAINT "runner_job_claim_recovery_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_job_claim_recovery_expires_at_idx" ON "runner_job_claim_recovery" USING btree ("expires_at");