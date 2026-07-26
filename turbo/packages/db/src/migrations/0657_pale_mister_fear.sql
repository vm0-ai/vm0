ALTER TABLE "connector_catalog_sync_state" DROP CONSTRAINT "connector_catalog_sync_state_observed_identity_complete";--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" DROP CONSTRAINT "connector_catalog_sync_state_rejected_candidate_complete";--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" DROP CONSTRAINT "connector_catalog_compatibility_evaluation_pk";
--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "integrity_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "public_catalog_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "private_catalog_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "private_firewalls_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "runner_firewalls_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "public_catalog" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "private_catalog" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "private_firewalls" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ALTER COLUMN "runner_firewalls" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" ALTER COLUMN "integrity_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD COLUMN "catalog_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD COLUMN "catalog_digest" varchar(71) NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD COLUMN "catalog_raw_size" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD COLUMN "catalog_gzip" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" ADD COLUMN "catalog_digest" varchar(71) NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_observed_catalog_key" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_observed_catalog_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_rejected_catalog_key" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD COLUMN "last_rejected_catalog_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" ADD CONSTRAINT "connector_catalog_compatibility_evaluation_pk" PRIMARY KEY("source_id","schema_version","catalog_version","catalog_digest","executable_capability_digest");--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD CONSTRAINT "connector_catalog_active_snapshot_catalog_raw_size_positive" CHECK ("connector_catalog_active_snapshot"."catalog_raw_size" > 0);--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD CONSTRAINT "connector_catalog_active_snapshot_catalog_digest_valid" CHECK ("connector_catalog_active_snapshot"."catalog_digest" ~ '^sha256:[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" ADD CONSTRAINT "connector_catalog_compatibility_catalog_digest_valid" CHECK ("connector_catalog_compatibility_evaluation"."catalog_digest" ~ '^sha256:[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD CONSTRAINT "connector_catalog_sync_state_observed_identity_complete" CHECK ((
          "connector_catalog_sync_state"."last_observed_catalog_version" IS NULL
          AND "connector_catalog_sync_state"."last_observed_catalog_key" IS NULL
          AND "connector_catalog_sync_state"."last_observed_catalog_digest" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_observed_catalog_version" IS NOT NULL
          AND "connector_catalog_sync_state"."last_observed_catalog_key" IS NOT NULL
          AND "connector_catalog_sync_state"."last_observed_catalog_digest" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "connector_catalog_sync_state" ADD CONSTRAINT "connector_catalog_sync_state_rejected_candidate_complete" CHECK ((
          "connector_catalog_sync_state"."last_rejected_catalog_version" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_catalog_key" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_catalog_digest" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_pointer_etag" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_failure_code" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_rejected_failure_code" IS NOT NULL
          AND "connector_catalog_sync_state"."last_rejected_failure_code" <> 'source-unavailable'
          AND (
            (
              "connector_catalog_sync_state"."last_rejected_catalog_version" IS NOT NULL
              AND "connector_catalog_sync_state"."last_rejected_catalog_key" IS NOT NULL
              AND "connector_catalog_sync_state"."last_rejected_catalog_digest" IS NOT NULL
            ) OR "connector_catalog_sync_state"."last_rejected_pointer_etag" IS NOT NULL
          )
          AND (
            (
              "connector_catalog_sync_state"."last_rejected_catalog_version" IS NULL
              AND "connector_catalog_sync_state"."last_rejected_catalog_key" IS NULL
              AND "connector_catalog_sync_state"."last_rejected_catalog_digest" IS NULL
            ) OR (
              "connector_catalog_sync_state"."last_rejected_catalog_version" IS NOT NULL
              AND "connector_catalog_sync_state"."last_rejected_catalog_key" IS NOT NULL
              AND "connector_catalog_sync_state"."last_rejected_catalog_digest" IS NOT NULL
            )
          )
        ));
