CREATE TABLE "presentation_template_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"page_index" integer,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_presentation_template_uploads_role" CHECK ("presentation_template_uploads"."role" IN ('source', 'page')),
	CONSTRAINT "chk_presentation_template_uploads_page_index" CHECK (("presentation_template_uploads"."role" = 'page' AND "presentation_template_uploads"."page_index" >= 0) OR ("presentation_template_uploads"."role" = 'source' AND "presentation_template_uploads"."page_index" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "presentation_templates" ALTER COLUMN "source_storage_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "presentation_template_uploads" ADD CONSTRAINT "presentation_template_uploads_template_id_presentation_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."presentation_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_presentation_template_uploads_template" ON "presentation_template_uploads" USING btree ("template_id","page_index");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_template_uploads_source" ON "presentation_template_uploads" USING btree ("template_id") WHERE role = 'source';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_template_uploads_page" ON "presentation_template_uploads" USING btree ("template_id","page_index") WHERE role = 'page';