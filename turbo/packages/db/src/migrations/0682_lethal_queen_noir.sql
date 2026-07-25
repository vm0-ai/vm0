ALTER TABLE "connector_catalog_sync_state" DROP CONSTRAINT "connector_catalog_sync_state_attempt_metadata_complete";--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" DROP CONSTRAINT "connector_catalog_sync_state_rejection_authority_complete";--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD CONSTRAINT "connector_catalog_sync_state_attempt_cache_reuse_complete" CHECK ((
          "connector_catalog_sync_state"."last_attempt_outcome" IS NULL
          AND "connector_catalog_sync_state"."last_attempt_reused_cached_rejection" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_attempt_outcome" IS NOT NULL
          AND "connector_catalog_sync_state"."last_attempt_reused_cached_rejection" IS NOT NULL
          AND (
            "connector_catalog_sync_state"."last_attempt_reused_cached_rejection" = FALSE
            OR "connector_catalog_sync_state"."last_attempt_outcome" = 'rejected'
          )
        ));--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD CONSTRAINT "connector_catalog_sync_state_rejection_authority_complete" CHECK ((
          "connector_catalog_sync_state"."last_rejected_failure_code" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_backend_version" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_build_commit_sha" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_rejected_failure_code" IS NOT NULL
          AND "connector_catalog_sync_state"."last_rejected_backend_version" IS NOT NULL
          AND "connector_catalog_sync_state"."last_rejected_backend_version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
          AND (
            "connector_catalog_sync_state"."last_rejected_build_commit_sha" IS NULL
            OR "connector_catalog_sync_state"."last_rejected_build_commit_sha" ~ '^[a-f0-9]{40}$'
          )
        ));