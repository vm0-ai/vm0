CREATE TABLE "connector_catalog_runtime_projection_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" varchar(64) NOT NULL,
	"schema_version" integer NOT NULL,
	"catalog_version" varchar(255) NOT NULL,
	"catalog_digest" varchar(71) NOT NULL,
	"projection_version" integer NOT NULL,
	"connector_count" integer NOT NULL,
	CONSTRAINT "connector_catalog_projection_sets_schema_positive" CHECK ("connector_catalog_runtime_projection_sets"."schema_version" > 0),
	CONSTRAINT "connector_catalog_projection_sets_version_positive" CHECK ("connector_catalog_runtime_projection_sets"."projection_version" > 0),
	CONSTRAINT "connector_catalog_projection_sets_count_positive" CHECK ("connector_catalog_runtime_projection_sets"."connector_count" > 0),
	CONSTRAINT "connector_catalog_projection_sets_digest_valid" CHECK ("connector_catalog_runtime_projection_sets"."catalog_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "connector_catalog_runtime_projections" (
	"projection_set_id" uuid NOT NULL,
	"connector_slug" varchar(64) NOT NULL,
	"connector_digest" varchar(71) NOT NULL,
	"connector" jsonb NOT NULL,
	CONSTRAINT "connector_catalog_runtime_projections_pk" PRIMARY KEY("projection_set_id","connector_slug"),
	CONSTRAINT "connector_catalog_projections_connector_digest_valid" CHECK ("connector_catalog_runtime_projections"."connector_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projection_sets" ADD CONSTRAINT "connector_catalog_runtime_projection_sets_sync_state_fk" FOREIGN KEY ("source_id","schema_version") REFERENCES "public"."connector_catalog_sync_state"("source_id","schema_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projections" ADD CONSTRAINT "connector_catalog_runtime_projections_set_fk" FOREIGN KEY ("projection_set_id") REFERENCES "public"."connector_catalog_runtime_projection_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_catalog_runtime_projection_sets_source_schema_unique" ON "connector_catalog_runtime_projection_sets" USING btree ("source_id","schema_version");
