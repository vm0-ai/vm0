-- Compose Jobs table for async compose-from-github operations
CREATE TABLE IF NOT EXISTS "compose_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"github_url" text NOT NULL,
	"overwrite" boolean DEFAULT false NOT NULL,
	"status" varchar(20) NOT NULL,
	"sandbox_id" varchar(255),
	"result" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_compose_jobs_user_status" ON "compose_jobs" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_compose_jobs_created" ON "compose_jobs" USING btree ("created_at");
