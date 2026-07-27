CREATE TABLE "connector_catalog_runtime_projection" (
	"source_id" varchar(64) NOT NULL,
	"schema_version" integer NOT NULL,
	"catalog_version" varchar(255) NOT NULL,
	"catalog_digest" varchar(71) NOT NULL,
	"projection_version" integer NOT NULL,
	"connector_ref" varchar(64) NOT NULL,
	"connector_digest" varchar(71) NOT NULL,
	"connector" jsonb NOT NULL,
	CONSTRAINT "connector_catalog_runtime_projection_pk" PRIMARY KEY("source_id","schema_version","catalog_version","catalog_digest","projection_version","connector_ref"),
	CONSTRAINT "connector_catalog_runtime_projection_schema_version_positive" CHECK ("connector_catalog_runtime_projection"."schema_version" > 0),
	CONSTRAINT "connector_catalog_runtime_projection_version_positive" CHECK ("connector_catalog_runtime_projection"."projection_version" > 0),
	CONSTRAINT "connector_catalog_runtime_projection_catalog_digest_valid" CHECK ("connector_catalog_runtime_projection"."catalog_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "connector_catalog_runtime_projection_connector_digest_valid" CHECK ("connector_catalog_runtime_projection"."connector_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD COLUMN "runtime_projection_version" integer;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD COLUMN "runtime_projection_catalog_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD COLUMN "runtime_projection_connector_count" integer;--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projection" ADD CONSTRAINT "connector_catalog_runtime_projection_sync_state_fk" FOREIGN KEY ("source_id","schema_version") REFERENCES "public"."connector_catalog_sync_state"("source_id","schema_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_catalog_active_snapshot" ADD CONSTRAINT "connector_catalog_active_snapshot_runtime_projection_complete" CHECK ((
          "connector_catalog_active_snapshot"."runtime_projection_version" IS NULL
          AND "connector_catalog_active_snapshot"."runtime_projection_catalog_digest" IS NULL
          AND "connector_catalog_active_snapshot"."runtime_projection_connector_count" IS NULL
        ) OR (
          "connector_catalog_active_snapshot"."runtime_projection_version" IS NOT NULL
          AND "connector_catalog_active_snapshot"."runtime_projection_catalog_digest" IS NOT NULL
          AND "connector_catalog_active_snapshot"."runtime_projection_connector_count" IS NOT NULL
          AND "connector_catalog_active_snapshot"."runtime_projection_version" > 0
          AND "connector_catalog_active_snapshot"."runtime_projection_connector_count" > 0
          AND "connector_catalog_active_snapshot"."runtime_projection_catalog_digest" ~ '^sha256:[a-f0-9]{64}$'
        ));