CREATE TABLE "connector_catalog_active_snapshot" (
	"source_id" varchar(64) NOT NULL,
	"schema_version" integer NOT NULL,
	"catalog_version" varchar(255) NOT NULL,
	"integrity_digest" varchar(71) NOT NULL,
	"public_catalog_digest" varchar(71) NOT NULL,
	"private_catalog_digest" varchar(71) NOT NULL,
	"private_firewalls_digest" varchar(71) NOT NULL,
	"runner_firewalls_digest" varchar(71) NOT NULL,
	"public_catalog" text NOT NULL,
	"private_catalog" text NOT NULL,
	"private_firewalls" text NOT NULL,
	"runner_firewalls" text NOT NULL,
	"activated_at" timestamp NOT NULL,
	CONSTRAINT "connector_catalog_active_snapshot_pk" PRIMARY KEY("source_id","schema_version"),
	CONSTRAINT "connector_catalog_active_snapshot_schema_version_positive" CHECK ("connector_catalog_active_snapshot"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "connector_catalog_sync_state" (
	"source_id" varchar(64) NOT NULL,
	"schema_version" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_observed_catalog_version" varchar(255),
	"last_observed_integrity_digest" varchar(71),
	"last_observed_pointer_etag" text,
	"last_attempt_at" timestamp,
	"last_attempt_outcome" varchar(32),
	"last_success_at" timestamp,
	"last_failure_code" varchar(64),
	"last_rejected_catalog_version" varchar(255),
	"last_rejected_integrity_digest" varchar(71),
	"last_rejected_pointer_etag" text,
	"last_rejected_failure_code" varchar(64),
	CONSTRAINT "connector_catalog_sync_state_pk" PRIMARY KEY("source_id","schema_version"),
	CONSTRAINT "connector_catalog_sync_state_schema_version_positive" CHECK ("connector_catalog_sync_state"."schema_version" > 0),
	CONSTRAINT "connector_catalog_sync_state_revision_nonnegative" CHECK ("connector_catalog_sync_state"."revision" >= 0),
	CONSTRAINT "connector_catalog_sync_state_observed_identity_complete" CHECK ((
          "connector_catalog_sync_state"."last_observed_catalog_version" IS NULL
          AND "connector_catalog_sync_state"."last_observed_integrity_digest" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_observed_catalog_version" IS NOT NULL
          AND "connector_catalog_sync_state"."last_observed_integrity_digest" IS NOT NULL
        )),
	CONSTRAINT "connector_catalog_sync_state_attempt_complete" CHECK ((
          "connector_catalog_sync_state"."last_attempt_outcome" IS NULL
          AND "connector_catalog_sync_state"."last_attempt_at" IS NULL
          AND "connector_catalog_sync_state"."last_failure_code" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_attempt_outcome" = 'rejected'
          AND "connector_catalog_sync_state"."last_attempt_at" IS NOT NULL
          AND "connector_catalog_sync_state"."last_failure_code" IS NOT NULL
        ) OR (
          "connector_catalog_sync_state"."last_attempt_outcome" IN ('accepted', 'unchanged')
          AND "connector_catalog_sync_state"."last_attempt_at" IS NOT NULL
          AND "connector_catalog_sync_state"."last_failure_code" IS NULL
        )),
	CONSTRAINT "connector_catalog_sync_state_rejected_candidate_complete" CHECK ((
          "connector_catalog_sync_state"."last_rejected_catalog_version" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_integrity_digest" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_pointer_etag" IS NULL
          AND "connector_catalog_sync_state"."last_rejected_failure_code" IS NULL
        ) OR (
          "connector_catalog_sync_state"."last_rejected_failure_code" IS NOT NULL
          AND "connector_catalog_sync_state"."last_rejected_failure_code" <> 'source-unavailable'
          AND (
            (
              "connector_catalog_sync_state"."last_rejected_catalog_version" IS NOT NULL
              AND "connector_catalog_sync_state"."last_rejected_integrity_digest" IS NOT NULL
            ) OR "connector_catalog_sync_state"."last_rejected_pointer_etag" IS NOT NULL
          )
          AND (
            (
              "connector_catalog_sync_state"."last_rejected_catalog_version" IS NULL
              AND "connector_catalog_sync_state"."last_rejected_integrity_digest" IS NULL
            ) OR (
              "connector_catalog_sync_state"."last_rejected_catalog_version" IS NOT NULL
              AND "connector_catalog_sync_state"."last_rejected_integrity_digest" IS NOT NULL
            )
          )
        ))
);
--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD CONSTRAINT "connector_catalog_active_snapshot_sync_state_fk" FOREIGN KEY ("source_id","schema_version") REFERENCES "public"."connector_catalog_sync_state"("source_id","schema_version") ON DELETE no action ON UPDATE no action;