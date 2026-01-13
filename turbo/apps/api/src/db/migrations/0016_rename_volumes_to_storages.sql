-- Rename volumes table to storages
ALTER TABLE "volumes" RENAME TO "storages";
--> statement-breakpoint
-- Rename volume_versions table to storage_versions
ALTER TABLE "volume_versions" RENAME TO "storage_versions";
--> statement-breakpoint
-- Rename volume_id column to storage_id in storage_versions
ALTER TABLE "storage_versions" RENAME COLUMN "volume_id" TO "storage_id";
--> statement-breakpoint
-- Rename the unique index
ALTER INDEX "idx_volumes_user_name" RENAME TO "idx_storages_user_name";
--> statement-breakpoint
-- Update foreign key constraint names (PostgreSQL requires drop and recreate)
ALTER TABLE "storage_versions" DROP CONSTRAINT "volume_versions_volume_id_volumes_id_fk";
--> statement-breakpoint
ALTER TABLE "storage_versions" ADD CONSTRAINT "storage_versions_storage_id_storages_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "storages" DROP CONSTRAINT "volumes_head_version_id_volume_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "storages" ADD CONSTRAINT "storages_head_version_id_storage_versions_id_fk" FOREIGN KEY ("head_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE no action ON UPDATE no action;
