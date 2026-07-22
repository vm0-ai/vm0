UPDATE "storage_versions"
SET "archive_size" = 0
WHERE "archive_size" IS NULL;
--> statement-breakpoint
DROP INDEX "idx_storage_versions_archive_size_null";
--> statement-breakpoint
DROP TABLE "storage_archive_size_backfill_work";
--> statement-breakpoint
ALTER TABLE "storage_versions" ALTER COLUMN "archive_size" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "storage_versions" ADD CONSTRAINT "chk_storage_versions_archive_size_nonnegative" CHECK ("storage_versions"."archive_size" >= 0);
