CREATE TABLE IF NOT EXISTS "slack_compose_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"compose_job_id" uuid NOT NULL,
	"slack_workspace_id" varchar(255) NOT NULL,
	"slack_user_id" varchar(255) NOT NULL,
	"slack_channel_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_compose_requests_job" ON "slack_compose_requests" USING btree ("compose_job_id");
--> statement-breakpoint
ALTER TABLE "slack_compose_requests" ADD CONSTRAINT "slack_compose_requests_compose_job_id_compose_jobs_id_fk" FOREIGN KEY ("compose_job_id") REFERENCES "public"."compose_jobs"("id") ON DELETE cascade ON UPDATE no action;
