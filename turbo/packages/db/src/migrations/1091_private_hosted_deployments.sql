CREATE TABLE "private_hosted_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"public_brand" text NOT NULL,
	"status" varchar(32) DEFAULT 'uploading' NOT NULL,
	"deployment_version" integer NOT NULL,
	"artifact_url" text NOT NULL,
	"r2_prefix" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" varchar(64) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"entrypoint" text DEFAULT '/index.html' NOT NULL,
	"spa_fallback" boolean DEFAULT false NOT NULL,
	"file_count" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"url" text NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ready_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "private_hosted_deployments" ADD CONSTRAINT "private_hosted_deployments_site_id_hosted_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_hosted_deployments" ADD CONSTRAINT "fk_private_hosted_deployments_site_public_brand" FOREIGN KEY ("site_id","public_brand") REFERENCES "public"."hosted_sites"("id","public_brand") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_private_hosted_deployments_site" ON "private_hosted_deployments" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_private_hosted_deployments_site_version" ON "private_hosted_deployments" USING btree ("site_id","deployment_version");--> statement-breakpoint
CREATE INDEX "idx_private_hosted_deployments_org" ON "private_hosted_deployments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_private_hosted_deployments_status" ON "private_hosted_deployments" USING btree ("status");