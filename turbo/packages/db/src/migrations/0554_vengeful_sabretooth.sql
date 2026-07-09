DROP INDEX "idx_teams_org_connections_user_tenant";--> statement-breakpoint
ALTER TABLE "teams_org_connections" ALTER COLUMN "teams_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teams_org_connections" ADD COLUMN "teams_aad_object_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_org_connections_aad_tenant" ON "teams_org_connections" USING btree ("teams_aad_object_id","teams_tenant_id") WHERE teams_aad_object_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_org_connections_user_tenant" ON "teams_org_connections" USING btree ("teams_user_id","teams_tenant_id") WHERE teams_user_id IS NOT NULL;