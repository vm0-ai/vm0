CREATE TABLE "official_workflow_catalog_releases" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "official_workflow_catalog_release_hash_format" CHECK ("official_workflow_catalog_releases"."id" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "official_workflow_catalog_state" (
	"authority" varchar(32) PRIMARY KEY NOT NULL,
	"accepted_release_id" varchar(64) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "official_workflow_catalog_state_authority" CHECK ("official_workflow_catalog_state"."authority" = 'official')
);
--> statement-breakpoint
CREATE TABLE "official_workflow_definition_revisions" (
	"definition_name" varchar(64) NOT NULL,
	"revision" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"storage_name" varchar(256) NOT NULL,
	"storage_id" uuid NOT NULL,
	"storage_version" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "official_workflow_definition_revisions_pk" PRIMARY KEY("definition_name","revision"),
	CONSTRAINT "official_workflow_definition_revision_hash_format" CHECK ("official_workflow_definition_revisions"."revision" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" ADD CONSTRAINT "official_workflow_catalog_state_accepted_release_id_official_workflow_catalog_releases_id_fk" FOREIGN KEY ("accepted_release_id") REFERENCES "public"."official_workflow_catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_workflow_definition_revisions" ADD CONSTRAINT "official_workflow_definition_revisions_storage_id_storages_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_workflow_definition_revisions" ADD CONSTRAINT "official_workflow_definition_revisions_storage_version_storage_versions_id_fk" FOREIGN KEY ("storage_version") REFERENCES "public"."storage_versions"("id") ON DELETE no action ON UPDATE no action;