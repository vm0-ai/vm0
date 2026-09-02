-- vm0:non-transactional
CREATE TABLE IF NOT EXISTS "pi_memory_stage1_candidates" (
	"memory_storage_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"pi_session_id" varchar(255) NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_history_hash" varchar(64) NOT NULL,
	"source_completed_at" timestamp NOT NULL,
	"eligible_at" timestamp NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"retry_at" timestamp,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error_class" varchar(128),
	"raw_memory" text,
	"rollout_summary" text,
	"rollout_slug" varchar(255),
	"generated_at" timestamp,
	"last_selected_source_history_hash" varchar(64),
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_memory_stage1_candidates_pkey" PRIMARY KEY("memory_storage_id","pi_session_id"),
	CONSTRAINT "pi_memory_stage1_candidates_status_check" CHECK ("pi_memory_stage1_candidates"."status" IN (
          'pending',
          'leased',
          'succeeded',
          'succeeded_no_output',
          'retryable_failure',
          'terminal_failure'
        )),
	CONSTRAINT "pi_memory_stage1_candidates_source_hash_check" CHECK ("pi_memory_stage1_candidates"."source_history_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pi_memory_stage1_candidates_selected_hash_check" CHECK ("pi_memory_stage1_candidates"."last_selected_source_history_hash" IS NULL OR "pi_memory_stage1_candidates"."last_selected_source_history_hash" = "pi_memory_stage1_candidates"."source_history_hash"),
	CONSTRAINT "pi_memory_stage1_candidates_counts_check" CHECK ("pi_memory_stage1_candidates"."retry_count" >= 0 AND "pi_memory_stage1_candidates"."usage_count" >= 0),
	CONSTRAINT "pi_memory_stage1_candidates_lease_check" CHECK ((
          "pi_memory_stage1_candidates"."status" = 'leased' AND
          "pi_memory_stage1_candidates"."lease_token" IS NOT NULL AND
          "pi_memory_stage1_candidates"."lease_expires_at" IS NOT NULL
        ) OR (
          "pi_memory_stage1_candidates"."status" <> 'leased' AND
          "pi_memory_stage1_candidates"."lease_token" IS NULL AND
          "pi_memory_stage1_candidates"."lease_expires_at" IS NULL
        )),
	CONSTRAINT "pi_memory_stage1_candidates_state_check" CHECK ((
          "pi_memory_stage1_candidates"."status" IN ('pending', 'leased') AND
          "pi_memory_stage1_candidates"."retry_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_error_class" IS NULL AND
          "pi_memory_stage1_candidates"."raw_memory" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_summary" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_slug" IS NULL AND
          "pi_memory_stage1_candidates"."generated_at" IS NULL
        ) OR (
          "pi_memory_stage1_candidates"."status" = 'succeeded' AND
          "pi_memory_stage1_candidates"."retry_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_error_class" IS NULL AND
          "pi_memory_stage1_candidates"."raw_memory" IS NOT NULL AND
          "pi_memory_stage1_candidates"."rollout_summary" IS NOT NULL AND
          "pi_memory_stage1_candidates"."generated_at" IS NOT NULL
        ) OR (
          "pi_memory_stage1_candidates"."status" = 'succeeded_no_output' AND
          "pi_memory_stage1_candidates"."retry_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_error_class" IS NULL AND
          "pi_memory_stage1_candidates"."raw_memory" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_summary" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_slug" IS NULL AND
          "pi_memory_stage1_candidates"."generated_at" IS NOT NULL
        ) OR (
          "pi_memory_stage1_candidates"."status" = 'retryable_failure' AND
          "pi_memory_stage1_candidates"."retry_at" IS NOT NULL AND
          "pi_memory_stage1_candidates"."last_error_class" IS NOT NULL AND
          "pi_memory_stage1_candidates"."raw_memory" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_summary" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_slug" IS NULL AND
          "pi_memory_stage1_candidates"."generated_at" IS NULL
        ) OR (
          "pi_memory_stage1_candidates"."status" = 'terminal_failure' AND
          "pi_memory_stage1_candidates"."retry_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_error_class" IS NOT NULL AND
          "pi_memory_stage1_candidates"."raw_memory" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_summary" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_slug" IS NULL AND
          "pi_memory_stage1_candidates"."generated_at" IS NULL
        ))
);
--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" DROP CONSTRAINT IF EXISTS "pi_memory_stage1_candidates_source_history_hash_blobs_hash_fk";--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" ADD CONSTRAINT "pi_memory_stage1_candidates_source_history_hash_blobs_hash_fk" FOREIGN KEY ("source_history_hash") REFERENCES "public"."blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" DROP CONSTRAINT IF EXISTS "pi_memory_stage1_candidates_storage_owner_fk";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_storages_id_org_user";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "idx_storages_id_org_user" ON "storages" USING btree ("id","org_id","user_id");--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" ADD CONSTRAINT "pi_memory_stage1_candidates_storage_owner_fk" FOREIGN KEY ("memory_storage_id","org_id","user_id") REFERENCES "public"."storages"("id","org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_memory_stage1_candidates_eligible" ON "pi_memory_stage1_candidates" USING btree ("eligible_at","retry_at") WHERE "pi_memory_stage1_candidates"."status" IN ('pending', 'retryable_failure');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_memory_stage1_candidates_expired_lease" ON "pi_memory_stage1_candidates" USING btree ("lease_expires_at") WHERE "pi_memory_stage1_candidates"."status" = 'leased';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_memory_stage1_candidates_phase2" ON "pi_memory_stage1_candidates" USING btree ("memory_storage_id","generated_at","pi_session_id") WHERE "pi_memory_stage1_candidates"."status" IN ('succeeded', 'succeeded_no_output');--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_launch_snapshot_v2_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_launch_snapshot_v2_check" CHECK ((
          "agent_runs"."launch_snapshot" IS NULL OR (
            jsonb_typeof("agent_runs"."launch_snapshot") = 'object' AND
            jsonb_typeof("agent_runs"."launch_snapshot" -> 'framework') = 'string' AND
            "agent_runs"."launch_snapshot" ->> 'framework' = ANY (
              ARRAY['claude-code', 'codex', 'pi']
            ) AND
            jsonb_typeof(
              "agent_runs"."launch_snapshot" -> 'runnerProfile'
            ) = 'string' AND
            char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') >= 1 AND
            char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') <= 255 AND
            (
              (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' = '1'::jsonb
              ) OR (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile',
                  'piMemoryGenerationEnabled'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile' -
                  'piMemoryGenerationEnabled'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' = '2'::jsonb AND
                jsonb_typeof(
                  "agent_runs"."launch_snapshot" -> 'piMemoryGenerationEnabled'
                ) = 'boolean'
              )
            )
          )
        )) NOT VALID;--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_launch_snapshot_v2_check";--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_launch_snapshot_check";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME CONSTRAINT "agent_runs_launch_snapshot_v2_check" TO "agent_runs_launch_snapshot_check";--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pi_memory_stage1_candidate_blob_ref_count"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE' AND
    NEW.source_history_hash IS DISTINCT FROM OLD.source_history_hash
  ) THEN
    UPDATE "blobs"
    SET "ref_count" = "ref_count" + 1
    WHERE "hash" = NEW.source_history_hash;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pi memory candidate source blob does not exist';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' OR (
    TG_OP = 'UPDATE' AND
    NEW.source_history_hash IS DISTINCT FROM OLD.source_history_hash
  ) THEN
    UPDATE "blobs"
    SET "ref_count" = "ref_count" - 1
    WHERE "hash" = OLD.source_history_hash
      AND "ref_count" > 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pi memory candidate source blob has no retained reference';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "pi_memory_stage1_candidate_blob_ref_count_trigger"
ON "pi_memory_stage1_candidates";--> statement-breakpoint
CREATE TRIGGER "pi_memory_stage1_candidate_blob_ref_count_trigger"
AFTER INSERT OR UPDATE OF "source_history_hash" OR DELETE
ON "pi_memory_stage1_candidates"
FOR EACH ROW
EXECUTE FUNCTION "pi_memory_stage1_candidate_blob_ref_count"();
