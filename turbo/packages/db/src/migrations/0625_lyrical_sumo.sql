CREATE TABLE "storage_archive_size_backfill_work" (
	"storage_version_id" varchar(64) PRIMARY KEY NOT NULL,
	"claim_token" uuid NOT NULL,
	"lease_expires_at" timestamp NOT NULL,
	"attempt_count" integer NOT NULL,
	"last_attempt_at" timestamp NOT NULL,
	"outcome" varchar(16),
	"error_code" varchar(64),
	CONSTRAINT "chk_storage_archive_size_backfill_work_attempt_count" CHECK ("storage_archive_size_backfill_work"."attempt_count" > 0),
	CONSTRAINT "chk_storage_archive_size_backfill_work_outcome" CHECK ("storage_archive_size_backfill_work"."outcome" IS NULL OR "storage_archive_size_backfill_work"."outcome" IN ('missing', 'invalid', 'failed')),
	CONSTRAINT "chk_storage_archive_size_backfill_work_error" CHECK (("storage_archive_size_backfill_work"."outcome" IS NULL AND "storage_archive_size_backfill_work"."error_code" IS NULL)
          OR ("storage_archive_size_backfill_work"."outcome" IS NOT NULL AND "storage_archive_size_backfill_work"."error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "storage_archive_size_backfill_work" ADD CONSTRAINT "storage_archive_size_backfill_work_storage_version_id_storage_versions_id_fk" FOREIGN KEY ("storage_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_versions_archive_size_null" ON "storage_versions" USING btree ("id") WHERE "storage_versions"."archive_size" IS NULL;