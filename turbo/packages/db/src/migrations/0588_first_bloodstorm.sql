CREATE TABLE "presentation_template_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"template_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'uploading' NOT NULL,
	"source_filename" varchar(512) NOT NULL,
	"source_storage_version_id" varchar(64),
	"compiler_version" varchar(64),
	"compile_run_id" text,
	"error_code" varchar(64),
	"error_message" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"upload_committed_at" timestamp,
	"processing_started_at" timestamp,
	"completed_at" timestamp,
	CONSTRAINT "chk_presentation_template_imports_status" CHECK ("presentation_template_imports"."status" IN ('uploading', 'queued', 'processing', 'succeeded', 'failed')),
	CONSTRAINT "chk_presentation_template_imports_source" CHECK ("presentation_template_imports"."status" IN ('uploading', 'failed') OR "presentation_template_imports"."source_storage_version_id" IS NOT NULL),
	CONSTRAINT "chk_presentation_template_imports_terminal" CHECK (("presentation_template_imports"."status" = 'succeeded' AND "presentation_template_imports"."completed_at" IS NOT NULL AND "presentation_template_imports"."error_code" IS NULL AND "presentation_template_imports"."error_message" IS NULL) OR ("presentation_template_imports"."status" = 'failed' AND "presentation_template_imports"."completed_at" IS NOT NULL AND "presentation_template_imports"."error_code" IS NOT NULL) OR "presentation_template_imports"."status" IN ('uploading', 'queued', 'processing'))
);
--> statement-breakpoint
CREATE TABLE "presentation_template_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"template_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"source_import_id" uuid NOT NULL,
	"source_storage_version_id" varchar(64) NOT NULL,
	"package_storage_version_id" varchar(64) NOT NULL,
	"compiler_version" varchar(64) NOT NULL,
	"manifest" jsonb NOT NULL,
	"preview_s3_prefix" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_presentation_template_revisions_number" CHECK ("presentation_template_revisions"."revision_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "presentation_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"access_scope" varchar(16) DEFAULT 'private' NOT NULL,
	"active_revision_id" uuid,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	"deleted_at" timestamp,
	CONSTRAINT "chk_presentation_templates_access_scope" CHECK ("presentation_templates"."access_scope" IN ('private', 'organization'))
);
--> statement-breakpoint
ALTER TABLE "presentation_template_imports" ADD CONSTRAINT "presentation_template_imports_template_id_presentation_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."presentation_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_template_imports" ADD CONSTRAINT "presentation_template_imports_source_storage_version_id_storage_versions_id_fk" FOREIGN KEY ("source_storage_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_template_revisions" ADD CONSTRAINT "presentation_template_revisions_template_id_presentation_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."presentation_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_template_revisions" ADD CONSTRAINT "presentation_template_revisions_source_import_id_presentation_template_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."presentation_template_imports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_template_revisions" ADD CONSTRAINT "presentation_template_revisions_source_storage_version_id_storage_versions_id_fk" FOREIGN KEY ("source_storage_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_template_revisions" ADD CONSTRAINT "presentation_template_revisions_package_storage_version_id_storage_versions_id_fk" FOREIGN KEY ("package_storage_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_templates" ADD CONSTRAINT "presentation_templates_active_revision_id_presentation_template_revisions_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."presentation_template_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_presentation_template_imports_template_created" ON "presentation_template_imports" USING btree ("template_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_presentation_template_imports_org_status" ON "presentation_template_imports" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_presentation_template_imports_compile_run" ON "presentation_template_imports" USING btree ("compile_run_id");--> statement-breakpoint
CREATE INDEX "idx_presentation_template_imports_source_version" ON "presentation_template_imports" USING btree ("source_storage_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_template_imports_one_active" ON "presentation_template_imports" USING btree ("template_id") WHERE "presentation_template_imports"."status" IN ('uploading', 'queued', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_template_revisions_number_unique" ON "presentation_template_revisions" USING btree ("template_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_template_revisions_import_unique" ON "presentation_template_revisions" USING btree ("source_import_id");--> statement-breakpoint
CREATE INDEX "idx_presentation_template_revisions_org" ON "presentation_template_revisions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_presentation_template_revisions_package_version" ON "presentation_template_revisions" USING btree ("package_storage_version_id");--> statement-breakpoint
CREATE INDEX "idx_presentation_templates_org" ON "presentation_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_presentation_templates_org_owner" ON "presentation_templates" USING btree ("org_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_presentation_templates_active_revision" ON "presentation_templates" USING btree ("active_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_templates_org_name_unique" ON "presentation_templates" USING btree ("org_id",lower("name")) WHERE "presentation_templates"."access_scope" = 'organization' AND "presentation_templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_templates_private_name_unique" ON "presentation_templates" USING btree ("org_id","owner_user_id",lower("name")) WHERE "presentation_templates"."access_scope" = 'private' AND "presentation_templates"."deleted_at" IS NULL;