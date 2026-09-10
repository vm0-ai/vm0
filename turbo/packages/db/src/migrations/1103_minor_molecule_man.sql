CREATE TABLE "image_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_file_id" uuid NOT NULL,
	"title" text NOT NULL,
	"visibility" varchar(16) DEFAULT 'private' NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_image_references_source_file" UNIQUE("source_file_id"),
	CONSTRAINT "chk_image_references_visibility" CHECK ("image_references"."visibility" IN ('private', 'public')),
	CONSTRAINT "chk_image_references_title" CHECK (char_length(trim("image_references"."title")) BETWEEN 1 AND 80),
	CONSTRAINT "chk_image_references_dimensions" CHECK ("image_references"."width" > 0 AND "image_references"."height" > 0 AND "image_references"."width" <= 16384 AND "image_references"."height" <= 16384 AND "image_references"."width" * "image_references"."height" <= 67108864)
);
--> statement-breakpoint
ALTER TABLE "image_references" ADD CONSTRAINT "image_references_source_file_id_run_uploaded_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."run_uploaded_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_image_references_owner_created" ON "image_references" USING btree ("org_id","owner_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_image_references_org_public_created" ON "image_references" USING btree ("org_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "image_references"."visibility" = 'public';