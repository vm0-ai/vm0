ALTER TABLE "hosted_deployments" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "hosted_sites" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hosted_sites_id_public_brand" ON "hosted_sites" USING btree ("id","public_brand");--> statement-breakpoint
ALTER TABLE "hosted_deployments" ADD CONSTRAINT "fk_hosted_deployments_site_public_brand" FOREIGN KEY ("site_id","public_brand") REFERENCES "public"."hosted_sites"("id","public_brand") ON DELETE cascade ON UPDATE no action;
