CREATE TABLE "pi_memory_phase2_jobs" (
	"memory_storage_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"input_revision" integer DEFAULT 1 NOT NULL,
	"completed_revision" integer DEFAULT 0 NOT NULL,
	"claimed_revision" integer,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp,
	"last_error_class" varchar(128),
	"last_succeeded_at" timestamp,
	"claimed_selection_digest" varchar(64),
	"claimed_selected_count" integer,
	"claimed_selected_utf8_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_memory_phase2_jobs_pkey" PRIMARY KEY("memory_storage_id"),
	CONSTRAINT "pi_memory_phase2_jobs_status_check" CHECK ("pi_memory_phase2_jobs"."status" IN ('idle', 'pending', 'leased', 'retryable_failure', 'terminal_failure')),
	CONSTRAINT "pi_memory_phase2_jobs_revisions_check" CHECK ("pi_memory_phase2_jobs"."input_revision" > 0 AND
          "pi_memory_phase2_jobs"."completed_revision" >= 0 AND
          "pi_memory_phase2_jobs"."completed_revision" <= "pi_memory_phase2_jobs"."input_revision" AND
          (
            "pi_memory_phase2_jobs"."claimed_revision" IS NULL OR (
              "pi_memory_phase2_jobs"."completed_revision" < "pi_memory_phase2_jobs"."claimed_revision" AND
              "pi_memory_phase2_jobs"."claimed_revision" <= "pi_memory_phase2_jobs"."input_revision"
            )
          )),
	CONSTRAINT "pi_memory_phase2_jobs_retry_count_check" CHECK ("pi_memory_phase2_jobs"."retry_count" >= 0 AND "pi_memory_phase2_jobs"."retry_count" <= 3),
	CONSTRAINT "pi_memory_phase2_jobs_error_class_check" CHECK ("pi_memory_phase2_jobs"."last_error_class" IS NULL OR "pi_memory_phase2_jobs"."last_error_class" ~ '^[a-z][a-z0-9_]{0,127}$'),
	CONSTRAINT "pi_memory_phase2_jobs_selection_check" CHECK ((
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NULL
        ) OR (
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selection_digest" ~ '^[0-9a-f]{64}$' AND
          "pi_memory_phase2_jobs"."claimed_selected_count" >= 0 AND
          "pi_memory_phase2_jobs"."claimed_selected_count" <= 256 AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" >= 0 AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" <= 21036800
        )),
	CONSTRAINT "pi_memory_phase2_jobs_state_check" CHECK ((
          "pi_memory_phase2_jobs"."status" = 'idle' AND
          "pi_memory_phase2_jobs"."completed_revision" = "pi_memory_phase2_jobs"."input_revision" AND
          "pi_memory_phase2_jobs"."claimed_revision" IS NULL AND
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
          "pi_memory_phase2_jobs"."lease_token" IS NULL AND
          "pi_memory_phase2_jobs"."lease_expires_at" IS NULL AND
          "pi_memory_phase2_jobs"."retry_count" = 3 AND
          "pi_memory_phase2_jobs"."retry_at" IS NULL AND
          "pi_memory_phase2_jobs"."last_error_class" IS NOT NULL AND
          "pi_memory_phase2_jobs"."claimed_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_count" IS NULL AND
          "pi_memory_phase2_jobs"."claimed_selected_utf8_bytes" IS NULL
        ))
);
--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_storage_owner_fk" FOREIGN KEY ("memory_storage_id","org_id","user_id") REFERENCES "public"."storages"("id","org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pi_memory_phase2_jobs_claimable" ON "pi_memory_phase2_jobs" USING btree ("status","retry_at","lease_expires_at","last_succeeded_at","updated_at","memory_storage_id") WHERE "pi_memory_phase2_jobs"."completed_revision" < "pi_memory_phase2_jobs"."input_revision" AND "pi_memory_phase2_jobs"."status" IN ('pending', 'leased', 'retryable_failure');--> statement-breakpoint
CREATE INDEX "idx_pi_memory_phase2_jobs_user_export" ON "pi_memory_phase2_jobs" USING btree ("user_id","org_id","memory_storage_id");
--> statement-breakpoint
INSERT INTO "pi_memory_phase2_jobs" (
	"memory_storage_id",
	"org_id",
	"user_id",
	"status",
	"input_revision",
	"completed_revision",
	"retry_count"
)
SELECT DISTINCT
	"memory_storage_id",
	"org_id",
	"user_id",
	'pending',
	1,
	0,
	0
FROM "pi_memory_stage1_candidates"
WHERE "status" IN ('succeeded', 'succeeded_no_output')
ON CONFLICT ("memory_storage_id") DO NOTHING;
