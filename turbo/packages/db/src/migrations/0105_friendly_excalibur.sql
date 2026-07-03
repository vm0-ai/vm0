ALTER TABLE "org_access_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "org_access_tokens" CASCADE;--> statement-breakpoint
DROP INDEX "idx_connectors_scope_type";--> statement-breakpoint
DROP INDEX "idx_model_providers_scope_type";--> statement-breakpoint
DROP INDEX "idx_scopes_owner";--> statement-breakpoint
DROP INDEX "idx_scopes_type";--> statement-breakpoint
DROP INDEX "idx_secrets_scope_name_type";--> statement-breakpoint
DROP INDEX "idx_variables_scope_name";--> statement-breakpoint
-- Backfill scopes.clerk_org_id: assign sentinel for rows missing it
UPDATE "scopes" SET "clerk_org_id" = 'org_backfill_' || "id"::text WHERE "clerk_org_id" IS NULL;
--> statement-breakpoint
-- Backfill NULL user_id on resource tables: assign to scope admin
UPDATE "secrets" SET "user_id" = (
  SELECT sm."user_id" FROM "scope_members" sm
  WHERE sm."scope_id" = "secrets"."scope_id" AND sm."role" = 'admin'
  ORDER BY sm."created_at" ASC LIMIT 1
) WHERE "user_id" IS NULL;
--> statement-breakpoint
UPDATE "variables" SET "user_id" = (
  SELECT sm."user_id" FROM "scope_members" sm
  WHERE sm."scope_id" = "variables"."scope_id" AND sm."role" = 'admin'
  ORDER BY sm."created_at" ASC LIMIT 1
) WHERE "user_id" IS NULL;
--> statement-breakpoint
UPDATE "connectors" SET "user_id" = (
  SELECT sm."user_id" FROM "scope_members" sm
  WHERE sm."scope_id" = "connectors"."scope_id" AND sm."role" = 'admin'
  ORDER BY sm."created_at" ASC LIMIT 1
) WHERE "user_id" IS NULL;
--> statement-breakpoint
UPDATE "model_providers" SET "user_id" = (
  SELECT sm."user_id" FROM "scope_members" sm
  WHERE sm."scope_id" = "model_providers"."scope_id" AND sm."role" = 'admin'
  ORDER BY sm."created_at" ASC LIMIT 1
) WHERE "user_id" IS NULL;
--> statement-breakpoint
-- Backfill agent_runs.scope_id: derive from compose chain
UPDATE "agent_runs" SET "scope_id" = (
  SELECT ac."scope_id" FROM "agent_compose_versions" acv
  JOIN "agent_composes" ac ON ac."id" = acv."compose_id"
  WHERE acv."id" = "agent_runs"."agent_compose_version_id"
) WHERE "scope_id" IS NULL;
--> statement-breakpoint
-- Delete orphan rows that couldn't be backfilled (no scope_members or compose chain)
DELETE FROM "secrets" WHERE "user_id" IS NULL;
--> statement-breakpoint
DELETE FROM "variables" WHERE "user_id" IS NULL;
--> statement-breakpoint
DELETE FROM "connectors" WHERE "user_id" IS NULL;
--> statement-breakpoint
DELETE FROM "model_providers" WHERE "user_id" IS NULL;
--> statement-breakpoint
DELETE FROM "agent_runs" WHERE "scope_id" IS NULL;
--> statement-breakpoint
-- Now safe to add NOT NULL constraints
ALTER TABLE "agent_runs" ALTER COLUMN "scope_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scopes" ALTER COLUMN "clerk_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "variables" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_scope_user_type" ON "connectors" USING btree ("scope_id","user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_providers_scope_user_type" ON "model_providers" USING btree ("scope_id","user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_secrets_scope_user_name_type" ON "secrets" USING btree ("scope_id","user_id","name","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_variables_scope_user_name" ON "variables" USING btree ("scope_id","user_id","name");--> statement-breakpoint
ALTER TABLE "scopes" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "scopes" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "scopes" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "scopes" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "scopes" DROP COLUMN "notify_email";--> statement-breakpoint
ALTER TABLE "scopes" DROP COLUMN "notify_slack";--> statement-breakpoint
DROP TYPE "public"."scope_type";