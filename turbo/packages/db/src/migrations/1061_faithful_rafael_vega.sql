CREATE TABLE "pi_memory_publication_provenance" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"memory_storage_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"claimed_revision" integer NOT NULL,
	"input_revision" integer NOT NULL,
	"reconciliation_revision" integer NOT NULL,
	"selection_digest" varchar(64) NOT NULL,
	"selected_count" integer NOT NULL,
	"selected_utf8_bytes" integer NOT NULL,
	"base_version_id" varchar(64) NOT NULL,
	"prepared_version_id" varchar(64) NOT NULL,
	"observed_head_version_id" varchar(64) NOT NULL,
	"writer" varchar(16) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"size" bigint NOT NULL,
	"archive_size" bigint NOT NULL,
	"file_count" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "pi_memory_publication_provenance_pkey" PRIMARY KEY("id"),
	CONSTRAINT "pi_memory_publication_provenance_revisions_check" CHECK ("pi_memory_publication_provenance"."claimed_revision" > 0 AND
          "pi_memory_publication_provenance"."input_revision" >= "pi_memory_publication_provenance"."claimed_revision" AND
          "pi_memory_publication_provenance"."reconciliation_revision" >= 0 AND
          "pi_memory_publication_provenance"."reconciliation_revision" <= "pi_memory_publication_provenance"."input_revision"),
	CONSTRAINT "pi_memory_publication_provenance_selection_check" CHECK ("pi_memory_publication_provenance"."selection_digest" ~ '^[0-9a-f]{64}$' AND
          "pi_memory_publication_provenance"."selected_count" >= 0 AND "pi_memory_publication_provenance"."selected_count" <= 256 AND
          "pi_memory_publication_provenance"."selected_utf8_bytes" >= 0 AND "pi_memory_publication_provenance"."selected_utf8_bytes" <= 21036800),
	CONSTRAINT "pi_memory_publication_provenance_versions_check" CHECK ("pi_memory_publication_provenance"."base_version_id" ~ '^[0-9a-f]{64}$' AND
          "pi_memory_publication_provenance"."prepared_version_id" ~ '^[0-9a-f]{64}$' AND
          "pi_memory_publication_provenance"."observed_head_version_id" ~ '^[0-9a-f]{64}$' AND
          "pi_memory_publication_provenance"."base_version_id" <> "pi_memory_publication_provenance"."prepared_version_id"),
	CONSTRAINT "pi_memory_publication_provenance_writer_check" CHECK ("pi_memory_publication_provenance"."writer" IN ('pi', 'reconciler')),
	CONSTRAINT "pi_memory_publication_provenance_outcome_check" CHECK ("pi_memory_publication_provenance"."outcome" IN ('published', 'conflicted') AND
          ("pi_memory_publication_provenance"."outcome" <> 'published' OR "pi_memory_publication_provenance"."observed_head_version_id" = "pi_memory_publication_provenance"."prepared_version_id")),
	CONSTRAINT "pi_memory_publication_provenance_counts_check" CHECK ("pi_memory_publication_provenance"."size" >= 0 AND "pi_memory_publication_provenance"."archive_size" >= 0 AND "pi_memory_publication_provenance"."file_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_revisions_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_state_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "reconciliation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "claimed_base_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_observed_head_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "conflict_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_conflict_at" timestamp;--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_conflicting_head_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_published_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD COLUMN "last_published_at" timestamp;--> statement-breakpoint
ALTER TABLE "pi_memory_publication_provenance" ADD CONSTRAINT "pi_memory_publication_provenance_storage_owner_fk" FOREIGN KEY ("memory_storage_id","org_id","user_id") REFERENCES "public"."storages"("id","org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pi_memory_publication_provenance_attempt" ON "pi_memory_publication_provenance" USING btree ("memory_storage_id","claimed_revision","base_version_id","prepared_version_id");--> statement-breakpoint
CREATE INDEX "idx_pi_memory_publication_provenance_user_export" ON "pi_memory_publication_provenance" USING btree ("user_id","org_id","memory_storage_id","created_at");--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_version_ids_check" CHECK (("pi_memory_phase2_jobs"."claimed_base_version_id" IS NULL OR "pi_memory_phase2_jobs"."claimed_base_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_observed_head_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_observed_head_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_conflicting_head_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_conflicting_head_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_published_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_published_version_id" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_conflict_check" CHECK (("pi_memory_phase2_jobs"."conflict_count" = 0 AND "pi_memory_phase2_jobs"."last_conflict_at" IS NULL AND "pi_memory_phase2_jobs"."last_conflicting_head_version_id" IS NULL) OR
          ("pi_memory_phase2_jobs"."conflict_count" > 0 AND "pi_memory_phase2_jobs"."last_conflict_at" IS NOT NULL AND "pi_memory_phase2_jobs"."last_conflicting_head_version_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_publication_check" CHECK (("pi_memory_phase2_jobs"."last_published_version_id" IS NULL AND "pi_memory_phase2_jobs"."last_published_at" IS NULL) OR
          ("pi_memory_phase2_jobs"."last_published_version_id" IS NOT NULL AND "pi_memory_phase2_jobs"."last_published_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_revisions_check" CHECK ("pi_memory_phase2_jobs"."input_revision" > 0 AND
          "pi_memory_phase2_jobs"."completed_revision" >= 0 AND
          "pi_memory_phase2_jobs"."completed_revision" <= "pi_memory_phase2_jobs"."input_revision" AND
          "pi_memory_phase2_jobs"."reconciliation_revision" >= 0 AND
          "pi_memory_phase2_jobs"."reconciliation_revision" <= "pi_memory_phase2_jobs"."input_revision" AND
          (
            "pi_memory_phase2_jobs"."claimed_revision" IS NULL OR (
              "pi_memory_phase2_jobs"."completed_revision" < "pi_memory_phase2_jobs"."claimed_revision" AND
              "pi_memory_phase2_jobs"."claimed_revision" <= "pi_memory_phase2_jobs"."input_revision"
            )
          ));--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_state_check" CHECK ((
          "pi_memory_phase2_jobs"."status" = 'idle' AND
          "pi_memory_phase2_jobs"."completed_revision" = "pi_memory_phase2_jobs"."input_revision" AND
          "pi_memory_phase2_jobs"."claimed_revision" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_base_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."lease_token" IS NULL AND
          "pi_memory_phase2_jobs"."lease_expires_at" IS NULL AND
          "pi_memory_phase2_jobs"."retry_count" = 0 AND
          "pi_memory_phase2_jobs"."retry_at" IS NULL AND
          "pi_memory_phase2_jobs"."last_error_class" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NULL
        ) OR (
          "pi_memory_phase2_jobs"."status" = 'pending' AND
          "pi_memory_phase2_jobs"."completed_revision" < "pi_memory_phase2_jobs"."input_revision" AND
          "pi_memory_phase2_jobs"."claimed_revision" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_base_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."lease_token" IS NULL AND
          "pi_memory_phase2_jobs"."lease_expires_at" IS NULL AND
          "pi_memory_phase2_jobs"."retry_count" = 0 AND
          "pi_memory_phase2_jobs"."retry_at" IS NULL AND
          "pi_memory_phase2_jobs"."last_error_class" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NULL
        ) OR (
          "pi_memory_phase2_jobs"."status" = 'leased' AND
          "pi_memory_phase2_jobs"."claimed_revision" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_base_version_id" IS NOT NULL AND
          "pi_memory_phase2_jobs"."completed_revision" < "pi_memory_phase2_jobs"."claimed_revision" AND
          "pi_memory_phase2_jobs"."claimed_revision" <= "pi_memory_phase2_jobs"."input_revision" AND
          "pi_memory_phase2_jobs"."lease_token" IS NOT NULL AND
          "pi_memory_phase2_jobs"."lease_expires_at" IS NOT NULL AND
          "pi_memory_phase2_jobs"."retry_count" >= 0 AND
          "pi_memory_phase2_jobs"."retry_count" < 3 AND
          "pi_memory_phase2_jobs"."retry_at" IS NULL AND
          "pi_memory_phase2_jobs"."last_error_class" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NOT NULL
        ) OR (
          "pi_memory_phase2_jobs"."status" = 'retryable_failure' AND
          "pi_memory_phase2_jobs"."completed_revision" < "pi_memory_phase2_jobs"."input_revision" AND
          "pi_memory_phase2_jobs"."claimed_revision" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_base_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."lease_token" IS NULL AND
          "pi_memory_phase2_jobs"."lease_expires_at" IS NULL AND
          "pi_memory_phase2_jobs"."retry_count" > 0 AND
          "pi_memory_phase2_jobs"."retry_count" < 3 AND
          "pi_memory_phase2_jobs"."retry_at" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_error_class" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NULL
        ) OR (
          "pi_memory_phase2_jobs"."status" = 'terminal_failure' AND
          "pi_memory_phase2_jobs"."completed_revision" < "pi_memory_phase2_jobs"."input_revision" AND
          "pi_memory_phase2_jobs"."claimed_revision" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_base_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."lease_token" IS NULL AND
          "pi_memory_phase2_jobs"."lease_expires_at" IS NULL AND
          "pi_memory_phase2_jobs"."retry_count" = 3 AND
          "pi_memory_phase2_jobs"."retry_at" IS NULL AND
          "pi_memory_phase2_jobs"."last_error_class" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NULL
        ));