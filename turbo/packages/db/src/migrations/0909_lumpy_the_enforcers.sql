CREATE TABLE "custom_connector_skill_publications" (
	"version_id" varchar(64) PRIMARY KEY NOT NULL,
	"storage_id" uuid NOT NULL,
	"s3_prefix" text NOT NULL,
	"state" varchar(32) NOT NULL,
	"state_updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_custom_connector_skill_publications_state" CHECK ("custom_connector_skill_publications"."state" IN ('preparing', 'cleanup_claimed'))
);
--> statement-breakpoint
CREATE TABLE "deleted_custom_connector_skill_storages" (
	"storage_id" uuid PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"s3_prefix" text NOT NULL,
	"deleted_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_connector_skill_publications" ADD CONSTRAINT "custom_connector_skill_publications_storage_id_storages_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_custom_connector_skill_publications_state_time" ON "custom_connector_skill_publications" USING btree ("state","state_updated_at","version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_deleted_custom_connector_skill_storages_connector" ON "deleted_custom_connector_skill_storages" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_deleted_custom_connector_skill_storages_deleted" ON "deleted_custom_connector_skill_storages" USING btree ("deleted_at","storage_id");