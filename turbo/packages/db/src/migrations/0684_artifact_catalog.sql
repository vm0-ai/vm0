CREATE TABLE "artifact_catalog_pending_files" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"queued_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"kind" varchar(32) NOT NULL,
	"entity_id" uuid NOT NULL,
	"logical_key" text NOT NULL,
	"projection_file_id" uuid NOT NULL,
	"projection_created_at" timestamp NOT NULL,
	"title" text NOT NULL,
	"thumbnail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"generation_job_id" uuid,
	"model" text,
	"provider" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presentation_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hosted_site_id" uuid NOT NULL,
	"generation_job_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"generation_job_id" uuid,
	"model" text,
	"duration_seconds" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_catalog_pending_files" ADD CONSTRAINT "artifact_catalog_pending_files_file_id_run_uploaded_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."run_uploaded_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_artifacts" ADD CONSTRAINT "image_artifacts_file_id_run_uploaded_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."run_uploaded_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_artifacts" ADD CONSTRAINT "image_artifacts_generation_job_id_built_in_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."built_in_generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_artifacts" ADD CONSTRAINT "presentation_artifacts_hosted_site_id_hosted_sites_id_fk" FOREIGN KEY ("hosted_site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_artifacts" ADD CONSTRAINT "presentation_artifacts_generation_job_id_built_in_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."built_in_generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_artifacts" ADD CONSTRAINT "video_artifacts_file_id_run_uploaded_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."run_uploaded_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_artifacts" ADD CONSTRAINT "video_artifacts_generation_job_id_built_in_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."built_in_generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_catalog_pending_owner_idx" ON "artifact_catalog_pending_files" USING btree ("org_id","author_user_id","queued_at","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_kind_entity_unique" ON "artifacts" USING btree ("kind","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_author_logical_key_unique" ON "artifacts" USING btree ("org_id","author_user_id","logical_key");--> statement-breakpoint
CREATE INDEX "artifacts_author_created_idx" ON "artifacts" USING btree ("org_id","author_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "artifacts_author_kind_created_idx" ON "artifacts" USING btree ("org_id","author_user_id","kind","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "image_artifacts_file_unique" ON "image_artifacts" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_artifacts_site_unique" ON "presentation_artifacts" USING btree ("hosted_site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_artifacts_file_unique" ON "video_artifacts" USING btree ("file_id");