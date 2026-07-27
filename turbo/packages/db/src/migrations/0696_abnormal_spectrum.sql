DROP INDEX "idx_storages_org_user_name_type";--> statement-breakpoint
ALTER TABLE "storage_version_lineage" DROP COLUMN "storage_type";--> statement-breakpoint
ALTER TABLE "storages" DROP COLUMN "type";