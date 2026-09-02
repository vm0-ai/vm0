CREATE TABLE "memory_summary_projections" (
	"memory_storage_id" uuid NOT NULL,
	"storage_version_id" varchar(64) NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_class" varchar(128),
	"content" text,
	"source_hash" varchar(64),
	"source_size" integer,
	"token_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_summary_projections_memory_storage_id_storage_version_id_pk" PRIMARY KEY("memory_storage_id","storage_version_id"),
	CONSTRAINT "memory_summary_projections_status_check" CHECK ("memory_summary_projections"."status" IN ('pending', 'running', 'ready', 'missing', 'invalid', 'over_limit')),
	CONSTRAINT "memory_summary_projections_lease_check" CHECK ((
          "memory_summary_projections"."status" = 'running'
          AND "memory_summary_projections"."lease_id" IS NOT NULL
          AND "memory_summary_projections"."lease_expires_at" IS NOT NULL
        ) OR (
          "memory_summary_projections"."status" <> 'running'
          AND "memory_summary_projections"."lease_id" IS NULL
          AND "memory_summary_projections"."lease_expires_at" IS NULL
        )),
	CONSTRAINT "memory_summary_projections_content_check" CHECK ((
          "memory_summary_projections"."status" = 'ready'
          AND "memory_summary_projections"."content" IS NOT NULL
          AND "memory_summary_projections"."source_hash" IS NOT NULL
          AND "memory_summary_projections"."source_size" IS NOT NULL
          AND "memory_summary_projections"."token_count" IS NOT NULL
        ) OR (
          "memory_summary_projections"."status" <> 'ready'
          AND "memory_summary_projections"."content" IS NULL
          AND "memory_summary_projections"."source_hash" IS NULL
          AND "memory_summary_projections"."source_size" IS NULL
          AND "memory_summary_projections"."token_count" IS NULL
        )),
	CONSTRAINT "memory_summary_projections_attempt_count_check" CHECK ("memory_summary_projections"."attempt_count" >= 0),
	CONSTRAINT "memory_summary_projections_source_size_check" CHECK ("memory_summary_projections"."source_size" IS NULL OR "memory_summary_projections"."source_size" >= 0),
	CONSTRAINT "memory_summary_projections_token_count_check" CHECK ("memory_summary_projections"."token_count" IS NULL OR "memory_summary_projections"."token_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "memory_summary_projections" ADD CONSTRAINT "memory_summary_projections_memory_storage_id_storages_id_fk" FOREIGN KEY ("memory_storage_id") REFERENCES "public"."storages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_summary_projections" ADD CONSTRAINT "memory_summary_projections_storage_version_id_storage_versions_id_fk" FOREIGN KEY ("storage_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_summary_projections_pending" ON "memory_summary_projections" USING btree ("available_at","memory_storage_id","storage_version_id") WHERE "memory_summary_projections"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_memory_summary_projections_expired_lease" ON "memory_summary_projections" USING btree ("lease_expires_at","memory_storage_id","storage_version_id") WHERE "memory_summary_projections"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_memory_summary_projections_owner" ON "memory_summary_projections" USING btree ("org_id","user_id","memory_storage_id","storage_version_id");