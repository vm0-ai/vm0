ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_attempt_metadata_revision" integer;--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_attempt_reused_cached_rejection" boolean;--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_rejected_backend_version" varchar(64);--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_rejected_build_commit_sha" varchar(40);--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_rejected_candidate_fingerprint" varchar(71);--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD CONSTRAINT "connector_catalog_sync_state_attempt_metadata_complete" CHECK ((
          "connector_catalog_sync_state"."last_attempt_metadata_revision" IS NULL
          AND "connector_catalog_sync_state"."last_attempt_reused_cached_rejection" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_attempt_metadata_revision" IS NOT NULL
          AND "connector_catalog_sync_state"."last_attempt_metadata_revision" >= 0
          AND "connector_catalog_sync_state"."last_attempt_metadata_revision" <= "connector_catalog_sync_state"."revision"
          AND "connector_catalog_sync_state"."last_attempt_reused_cached_rejection" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD CONSTRAINT "connector_catalog_sync_state_rejection_authority_complete" CHECK ((
          "connector_catalog_sync_state"."last_rejected_backend_version" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_build_commit_sha" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_candidate_fingerprint" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_rejected_backend_version" IS NOT NULL
          AND "connector_catalog_sync_state"."last_rejected_backend_version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
          AND "connector_catalog_sync_state"."last_rejected_candidate_fingerprint" IS NOT NULL
          AND "connector_catalog_sync_state"."last_rejected_candidate_fingerprint" ~ '^sha256:[a-f0-9]{64}$'
          AND (
            "connector_catalog_sync_state"."last_rejected_build_commit_sha" IS NULL
            OR "connector_catalog_sync_state"."last_rejected_build_commit_sha" ~ '^[a-f0-9]{40}$'
          )
        ));