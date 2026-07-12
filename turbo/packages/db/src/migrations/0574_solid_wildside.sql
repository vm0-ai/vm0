DROP INDEX "runner_job_queue_group_profile_unclaimed_idx";--> statement-breakpoint
DROP INDEX "runner_job_queue_session_id_unclaimed_idx";--> statement-breakpoint
ALTER TABLE "runner_job_queue" DROP COLUMN "claimed_at";