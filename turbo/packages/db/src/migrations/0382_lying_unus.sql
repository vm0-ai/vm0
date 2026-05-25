CREATE TABLE "built_in_generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(32) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "built_in_generation_jobs" ADD CONSTRAINT "built_in_generation_jobs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_built_in_generation_jobs_user_created" ON "built_in_generation_jobs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_built_in_generation_jobs_org_status" ON "built_in_generation_jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_built_in_generation_jobs_run" ON "built_in_generation_jobs" USING btree ("run_id");