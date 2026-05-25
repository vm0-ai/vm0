CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"full_path" text NOT NULL,
	"storage_id" uuid,
	"version_hash" varchar(64),
	"commit_sha" varchar(40),
	"frontmatter" jsonb,
	"s3_key" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skills_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_storage_id_storages_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_skills_name" ON "skills" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_skills_storage_id" ON "skills" USING btree ("storage_id");