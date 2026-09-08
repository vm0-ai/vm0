CREATE TABLE "pi_memory_phase2_checkpoints" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"memory_storage_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"lease_token" uuid NOT NULL,
	"claimed_revision" integer NOT NULL,
	"claimed_base_version_id" varchar(64) NOT NULL,
	"selection_digest" varchar(64) NOT NULL,
	"version_id" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_memory_phase2_checkpoints_identity_check" CHECK ("pi_memory_phase2_checkpoints"."claimed_revision" > 0 AND
      "pi_memory_phase2_checkpoints"."claimed_base_version_id" ~ '^[0-9a-f]{64}$' AND
      "pi_memory_phase2_checkpoints"."selection_digest" ~ '^[0-9a-f]{64}$' AND
      "pi_memory_phase2_checkpoints"."version_id" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_execution_fence_check";--> statement-breakpoint
-- The required ALTER above holds the normal DDL lock for this transaction.
-- Classify before tightening 1077; never interpret an unavailable audit as zero.
-- Parent cardinality was 16,393 on 2026-09-05. Stop for a chunked rollout plan
-- if the real control population has grown beyond the reviewed bound.
DO $$
DECLARE
  job_count bigint;
  unsafe_count bigint;
BEGIN
  SELECT count(*) INTO job_count FROM pi_memory_phase2_jobs;
  IF job_count > 25000 THEN
    RAISE EXCEPTION 'Phase 2 checkpoint migration requires renewed scale review';
  END IF;
  SELECT count(*) INTO unsafe_count FROM pi_memory_phase2_jobs
  WHERE status = 'leased' AND (
    (legacy_lease_token IS NOT NULL AND legacy_lease_token = lease_token
      AND sandbox_lease_token IS NULL AND maintenance_run_id IS NULL)
    OR (legacy_lease_token IS NULL AND sandbox_lease_token IS NOT NULL
      AND sandbox_lease_token = lease_token)
    OR (legacy_lease_token IS NULL AND sandbox_lease_token IS NULL
      AND maintenance_run_id IS NULL AND lease_expires_at > CURRENT_TIMESTAMP)
  ) IS NOT TRUE;
  IF unsafe_count > 0 THEN
    RAISE EXCEPTION 'Phase 2 checkpoint migration requires exact lease classification (% rows)', unsafe_count;
  END IF;
  -- Only an already-active old-shape lease is grandfathered. The token remains
  -- exact; the old API cannot reuse it when it next claims with a fresh token.
  UPDATE pi_memory_phase2_jobs SET legacy_lease_token = lease_token
  WHERE status = 'leased' AND legacy_lease_token IS NULL
    AND sandbox_lease_token IS NULL AND maintenance_run_id IS NULL
    AND lease_expires_at > CURRENT_TIMESTAMP;
END $$;
--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_maintenance_history_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_checkpoints" ADD CONSTRAINT "pi_memory_phase2_checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_checkpoints" ADD CONSTRAINT "pi_memory_phase2_checkpoints_storage_owner_fk" FOREIGN KEY ("memory_storage_id","org_id","user_id") REFERENCES "public"."storages"("id","org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_execution_fence_check" CHECK ((
          "pi_memory_phase2_jobs"."status" = 'leased' AND (
            (
              "pi_memory_phase2_jobs"."legacy_lease_token" IS NOT NULL AND
              "pi_memory_phase2_jobs"."legacy_lease_token" = "pi_memory_phase2_jobs"."lease_token" AND
              "pi_memory_phase2_jobs"."sandbox_lease_token" IS NULL AND
              "pi_memory_phase2_jobs"."maintenance_run_id" IS NULL
            ) OR (
              "pi_memory_phase2_jobs"."legacy_lease_token" IS NULL AND
              "pi_memory_phase2_jobs"."sandbox_lease_token" IS NOT NULL AND
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
              "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NOT NULL
            )
          )
        ));