ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_version_ids_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "legacy_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "sandbox_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "maintenance_run_id" uuid;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_maintenance_run_id" uuid;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_maintenance_revision" integer;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_maintenance_base_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_maintenance_selection_digest" varchar(64);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_maintenance_checkpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_maintenance_checkpoint_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_maintenance_outcome" varchar(32);--> statement-breakpoint
-- DB/API rollout fence: existing leased rows belong to the pre-cutover API
-- publisher. Mark only those exact lease tokens so an old worker may finish
-- its current claim but cannot acquire a fresh post-cutover claim. Remove the
-- legacy columns/constraint under #31067 only after the outgoing API target
-- and every live legacy lease have drained (observed DB/API skew: ~102 min).
UPDATE "pi_memory_phase2_jobs"
SET "legacy_lease_token" = "lease_token"
WHERE "status" = 'leased';--> statement-breakpoint
CREATE INDEX "idx_pi_memory_phase2_jobs_maintenance_run" ON "pi_memory_phase2_jobs" USING btree ("maintenance_run_id") WHERE "pi_memory_phase2_jobs"."maintenance_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_execution_fence_check" CHECK ((
          "pi_memory_phase2_jobs"."status" = 'leased' AND (
            (
              "pi_memory_phase2_jobs"."legacy_lease_token" = "pi_memory_phase2_jobs"."lease_token" AND
              "pi_memory_phase2_jobs"."sandbox_lease_token" IS NULL AND
              "pi_memory_phase2_jobs"."maintenance_run_id" IS NULL
            ) OR (
              "pi_memory_phase2_jobs"."legacy_lease_token" IS NULL AND
              "pi_memory_phase2_jobs"."sandbox_lease_token" = "pi_memory_phase2_jobs"."lease_token"
            )
          )
        ) OR (
          "pi_memory_phase2_jobs"."status" <> 'leased' AND
          "pi_memory_phase2_jobs"."sandbox_lease_token" IS NULL AND
          "pi_memory_phase2_jobs"."maintenance_run_id" IS NULL
        ));--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_maintenance_history_check" CHECK ((
          "pi_memory_phase2_jobs"."last_maintenance_run_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_checkpoint_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_outcome" IS NULL
        ) OR (
          "pi_memory_phase2_jobs"."last_maintenance_run_id" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" > 0 AND
          "pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_outcome" IN ('published', 'no_diff', 'failed') AND
          (
            (
              "pi_memory_phase2_jobs"."last_maintenance_outcome" = 'failed' AND
              "pi_memory_phase2_jobs"."last_maintenance_checkpoint_id" IS NULL AND
              "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NULL
            ) OR (
              "pi_memory_phase2_jobs"."last_maintenance_outcome" IN ('published', 'no_diff') AND
              "pi_memory_phase2_jobs"."last_maintenance_checkpoint_id" IS NOT NULL AND
              "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NOT NULL
            )
          )
        ));--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_version_ids_check" CHECK (("pi_memory_phase2_jobs"."claimed_base_version_id" IS NULL OR "pi_memory_phase2_jobs"."claimed_base_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_observed_head_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_observed_head_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_conflicting_head_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_conflicting_head_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_published_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_published_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_maintenance_base_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NULL OR "pi_memory_phase2_jobs"."last_maintenance_selection_digest" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" ~ '^[0-9a-f]{64}$'));
