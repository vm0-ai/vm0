CREATE TABLE "socialkit_download_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" varchar(24) DEFAULT 'submitting' NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid,
	"public_brand" varchar(8) NOT NULL,
	"request" jsonb NOT NULL,
	"provider_job_id" text,
	"provider_result" jsonb,
	"artifact" jsonb,
	"error" jsonb,
	"credits_charged" bigint,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"claim_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "socialkit_download_jobs" ADD CONSTRAINT "socialkit_download_jobs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_socialkit_download_jobs_provider_job" ON "socialkit_download_jobs" USING btree ("provider_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_socialkit_download_jobs_user_active" ON "socialkit_download_jobs" USING btree ("user_id") WHERE status IN ('submitting', 'processing', 'materializing', 'artifact_failed');--> statement-breakpoint
CREATE INDEX "idx_socialkit_download_jobs_owner_created" ON "socialkit_download_jobs" USING btree ("org_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_socialkit_download_jobs_reconcile" ON "socialkit_download_jobs" USING btree ("status","claim_expires_at");--> statement-breakpoint
CREATE INDEX "idx_socialkit_download_jobs_run" ON "socialkit_download_jobs" USING btree ("run_id");