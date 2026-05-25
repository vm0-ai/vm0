DROP INDEX "runner_job_queue_group_unclaimed_idx";--> statement-breakpoint
ALTER TABLE "runner_job_queue" ADD COLUMN "profile" varchar(255) DEFAULT 'vm0/default' NOT NULL;--> statement-breakpoint
CREATE INDEX "runner_job_queue_group_profile_unclaimed_idx" ON "runner_job_queue" USING btree ("runner_group","profile") WHERE claimed_at IS NULL;