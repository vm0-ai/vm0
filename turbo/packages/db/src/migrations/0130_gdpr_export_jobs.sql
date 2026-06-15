CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"clerk_org_id" text NOT NULL,
	"status" varchar(20) NOT NULL,
	"s3_key" text,
	"artifact_urls" jsonb,
	"error" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_export_jobs_user_status" ON "export_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_export_jobs_created" ON "export_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_export_jobs_user_active" ON "export_jobs" USING btree ("user_id") WHERE status IN ('pending', 'running');
