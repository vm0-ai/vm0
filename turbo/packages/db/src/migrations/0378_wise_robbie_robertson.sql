CREATE TABLE "hosted_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"status" varchar(32) DEFAULT 'uploading' NOT NULL,
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
CREATE TABLE "hosted_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"public_slug" varchar(96) NOT NULL,
	"active_deployment_id" uuid,
	"created_from_run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "hosted_deployments" ADD CONSTRAINT "hosted_deployments_site_id_hosted_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hosted_deployments_site" ON "hosted_deployments" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "idx_hosted_deployments_org" ON "hosted_deployments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hosted_deployments_status" ON "hosted_deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_hosted_sites_org" ON "hosted_sites" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hosted_sites_org_slug" ON "hosted_sites" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hosted_sites_public_slug" ON "hosted_sites" USING btree ("public_slug");
