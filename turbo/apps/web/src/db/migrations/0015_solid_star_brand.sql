CREATE TABLE "volume_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"volume_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"message" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "volumes" ADD COLUMN "head_version_id" uuid;--> statement-breakpoint
ALTER TABLE "volume_versions" ADD CONSTRAINT "volume_versions_volume_id_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."volumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_head_version_id_volume_versions_id_fk" FOREIGN KEY ("head_version_id") REFERENCES "public"."volume_versions"("id") ON DELETE no action ON UPDATE no action;