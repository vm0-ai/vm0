ALTER TABLE "pi_memory_stage1_candidates" DROP CONSTRAINT "pi_memory_stage1_candidates_state_check";--> statement-breakpoint
UPDATE "pi_memory_stage1_candidates"
SET "last_selected_source_history_hash" = NULL
WHERE "last_selected_source_history_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" ADD CONSTRAINT "pi_memory_stage1_candidates_state_check" CHECK ((
          "pi_memory_stage1_candidates"."status" IN ('pending', 'leased') AND
          "pi_memory_stage1_candidates"."retry_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_error_class" IS NULL AND
          "pi_memory_stage1_candidates"."raw_memory" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_summary" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_slug" IS NULL AND
          "pi_memory_stage1_candidates"."generated_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_selected_source_history_hash" IS NULL
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
          "pi_memory_stage1_candidates"."generated_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_selected_source_history_hash" IS NULL
        ) OR (
          "pi_memory_stage1_candidates"."status" = 'terminal_failure' AND
          "pi_memory_stage1_candidates"."retry_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_error_class" IS NOT NULL AND
          "pi_memory_stage1_candidates"."raw_memory" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_summary" IS NULL AND
          "pi_memory_stage1_candidates"."rollout_slug" IS NULL AND
          "pi_memory_stage1_candidates"."generated_at" IS NULL AND
          "pi_memory_stage1_candidates"."last_selected_source_history_hash" IS NULL
        ));
