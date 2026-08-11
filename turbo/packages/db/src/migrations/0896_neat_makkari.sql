CREATE TABLE "presentation_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) DEFAULT 'private' NOT NULL,
	"title" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"error" jsonb,
	"source_storage_key" text NOT NULL,
	"source_filename" text NOT NULL,
	"page_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"aspect_ratio" real,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_presentation_templates_visibility" CHECK ("presentation_templates"."visibility" IN ('private', 'public')),
	CONSTRAINT "chk_presentation_templates_status" CHECK ("presentation_templates"."status" IN ('pending', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "idx_presentation_templates_owner_created" ON "presentation_templates" USING btree ("org_id","owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_templates_active_import" ON "presentation_templates" USING btree ("owner_user_id") WHERE status IN ('pending', 'processing');