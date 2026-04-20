-- Step 1: Add clerk_org_id as nullable to all 8 tables
ALTER TABLE "agent_composes" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "storages" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "variables" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint

-- Step 2: Backfill from scopes table
UPDATE "agent_composes" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint
UPDATE "agent_runs" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint
UPDATE "agent_schedules" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint
UPDATE "connectors" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint
UPDATE "model_providers" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint
UPDATE "secrets" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint
UPDATE "storages" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint
UPDATE "variables" t SET "clerk_org_id" = s."clerk_org_id" FROM "scopes" s WHERE t."scope_id" = s."id";--> statement-breakpoint

-- Step 3: Set NOT NULL after backfill
ALTER TABLE "agent_composes" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "storages" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "variables" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint

-- Step 4: Create indexes
CREATE INDEX "idx_agent_composes_clerk_org" ON "agent_composes" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_composes_clerk_org_name" ON "agent_composes" USING btree ("clerk_org_id","name");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_clerk_org" ON "agent_runs" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE INDEX "idx_agent_schedules_clerk_org" ON "agent_schedules" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_schedules_compose_name_clerk_org_user" ON "agent_schedules" USING btree ("compose_id","name","clerk_org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_connectors_clerk_org" ON "connectors" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_clerk_org_user_type" ON "connectors" USING btree ("clerk_org_id","user_id","type");--> statement-breakpoint
CREATE INDEX "idx_model_providers_clerk_org" ON "model_providers" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_providers_clerk_org_user_type" ON "model_providers" USING btree ("clerk_org_id","user_id","type");--> statement-breakpoint
CREATE INDEX "idx_secrets_clerk_org" ON "secrets" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_secrets_clerk_org_user_name_type" ON "secrets" USING btree ("clerk_org_id","user_id","name","type");--> statement-breakpoint
CREATE INDEX "idx_storages_clerk_org" ON "storages" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_storages_clerk_org_user_name_type" ON "storages" USING btree ("clerk_org_id","user_id","name","type");--> statement-breakpoint
CREATE INDEX "idx_variables_clerk_org" ON "variables" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_variables_clerk_org_user_name" ON "variables" USING btree ("clerk_org_id","user_id","name");
