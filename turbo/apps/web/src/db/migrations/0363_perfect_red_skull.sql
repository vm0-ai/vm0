CREATE TABLE "remote_agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"host_id" uuid,
	"backend" text,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"output" text,
	"error" text,
	"exit_code" integer,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_agent_jobs" ADD CONSTRAINT "remote_agent_jobs_host_id_remote_agent_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."remote_agent_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_remote_agent_jobs_host_status" ON "remote_agent_jobs" USING btree ("host_id","status");--> statement-breakpoint
CREATE INDEX "idx_remote_agent_jobs_org_user" ON "remote_agent_jobs" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_remote_agent_jobs_created" ON "remote_agent_jobs" USING btree ("created_at");
