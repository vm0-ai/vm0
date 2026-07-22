ALTER TABLE "hosted_deployments" ADD COLUMN "deployment_version" integer;--> statement-breakpoint
ALTER TABLE "hosted_deployments" ADD COLUMN "artifact_url" text;--> statement-breakpoint
ALTER TABLE "hosted_sites" ADD COLUMN "active_deployment_version" integer;--> statement-breakpoint
ALTER TABLE "hosted_sites" ADD COLUMN "next_deployment_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hosted_deployments_site_version" ON "hosted_deployments" USING btree ("site_id","deployment_version") WHERE "hosted_deployments"."deployment_version" IS NOT NULL;