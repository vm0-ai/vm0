ALTER TABLE "storage_version_lineage" ALTER COLUMN "storage_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "storages" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "storages" ALTER COLUMN "type" DROP NOT NULL;