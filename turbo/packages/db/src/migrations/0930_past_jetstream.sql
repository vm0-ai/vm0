ALTER TABLE "agentphone_user_agent_preferences" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "agentphone_user_links" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "github_user_links" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "slack_org_connections" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "teams_org_connections" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "telegram_official_user_links" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "telegram_user_links" ADD COLUMN "user_id" text;--> statement-breakpoint
UPDATE "agentphone_user_agent_preferences" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "agentphone_user_links" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "feishu_org_connections" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "feishu_user_agent_preferences" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "github_user_links" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "slack_org_connections" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "slack_user_agent_preferences" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "teams_org_connections" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "teams_user_agent_preferences" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "telegram_official_user_links" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "telegram_user_agent_preferences" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "telegram_user_links" SET "user_id" = "vm0_user_id" WHERE "user_id" IS NULL;--> statement-breakpoint
-- Expand-phase compatibility for #27599. Remove in #27602 only after the
-- Switch release is healthy, old API instances and callbacks have drained,
-- and both physical identity columns are verified equal and non-null.
CREATE FUNCTION "sync_integration_user_identity_0930"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW."vm0_user_id" IS DISTINCT FROM OLD."vm0_user_id"
			AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id" THEN
			NEW."user_id" := NEW."vm0_user_id";
		ELSIF NEW."user_id" IS DISTINCT FROM OLD."user_id"
			AND NEW."vm0_user_id" IS NOT DISTINCT FROM OLD."vm0_user_id" THEN
			NEW."vm0_user_id" := NEW."user_id";
		END IF;
	END IF;

	IF NEW."vm0_user_id" IS NULL AND NEW."user_id" IS NULL THEN
		RAISE EXCEPTION 'integration identity cannot be null for table %', TG_TABLE_NAME
			USING ERRCODE = '23502';
	ELSIF NEW."vm0_user_id" IS NULL THEN
		NEW."vm0_user_id" := NEW."user_id";
	ELSIF NEW."user_id" IS NULL THEN
		NEW."user_id" := NEW."vm0_user_id";
	ELSIF NEW."vm0_user_id" IS DISTINCT FROM NEW."user_id" THEN
		RAISE EXCEPTION 'conflicting integration identities for table %', TG_TABLE_NAME
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sync_agentphone_user_agent_preferences_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "agentphone_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_agentphone_user_links_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "agentphone_user_links"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_feishu_org_connections_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "feishu_org_connections"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_feishu_user_agent_preferences_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "feishu_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_github_user_links_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "github_user_links"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_slack_org_connections_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "slack_org_connections"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_slack_user_agent_preferences_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "slack_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_teams_org_connections_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "teams_org_connections"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_teams_user_agent_preferences_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "teams_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_telegram_official_user_links_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "telegram_official_user_links"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_telegram_user_agent_preferences_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "telegram_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE TRIGGER "sync_telegram_user_links_identity_0930"
BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id" ON "telegram_user_links"
FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"();--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agentphone_user_agent_preferences_user_org" ON "agentphone_user_agent_preferences" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agentphone_user_links_user_org" ON "agentphone_user_links" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_org_connections_user_id_installation" ON "feishu_org_connections" USING btree ("user_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_user_agent_preferences_user_org" ON "feishu_user_agent_preferences" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_slack_org_connections_user_id_workspace" ON "slack_org_connections" USING btree ("user_id","slack_workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_user_agent_preferences_user_org" ON "slack_user_agent_preferences" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_teams_org_connections_user_id_tenant" ON "teams_org_connections" USING btree ("user_id","teams_tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_user_agent_preferences_user_org" ON "teams_user_agent_preferences" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_official_user_links_user_org" ON "telegram_official_user_links" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_user_agent_preferences_user_org" ON "telegram_user_agent_preferences" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_user_links_user_id_installation" ON "telegram_user_links" USING btree ("user_id","installation_id");
