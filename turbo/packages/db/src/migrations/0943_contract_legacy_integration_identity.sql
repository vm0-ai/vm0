-- Re-run the canonical backfill before any destructive statement.
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

-- Abort the transaction before any Contract DDL if either identity is null or
-- the canonical and retired values conflict.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "agentphone_user_agent_preferences" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "agentphone_user_links" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "feishu_org_connections" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "feishu_user_agent_preferences" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "github_user_links" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "slack_org_connections" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "slack_user_agent_preferences" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "teams_org_connections" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "teams_user_agent_preferences" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "telegram_official_user_links" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "telegram_user_agent_preferences" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "telegram_user_links" WHERE "user_id" IS NULL OR "vm0_user_id" IS NULL OR "user_id" IS DISTINCT FROM "vm0_user_id"
	) THEN
		RAISE EXCEPTION 'integration identity Contract validation failed'
			USING ERRCODE = '23514';
	END IF;
END;
$$;--> statement-breakpoint

-- Reuse the validated canonical unique indexes as the five new primary keys.
ALTER TABLE "agentphone_user_agent_preferences" DROP CONSTRAINT "agentphone_user_agent_preferences_pkey";--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences" ADD CONSTRAINT "agentphone_user_agent_preferences_user_id_org_id_pk" PRIMARY KEY USING INDEX "idx_agentphone_user_agent_preferences_user_org";--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" DROP CONSTRAINT "feishu_user_agent_preferences_pkey";--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" ADD CONSTRAINT "feishu_user_agent_preferences_user_id_org_id_pk" PRIMARY KEY USING INDEX "idx_feishu_user_agent_preferences_user_org";--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" DROP CONSTRAINT "slack_user_agent_preferences_pkey";--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" ADD CONSTRAINT "slack_user_agent_preferences_user_id_org_id_pk" PRIMARY KEY USING INDEX "idx_slack_user_agent_preferences_user_org";--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" DROP CONSTRAINT "teams_user_agent_preferences_pkey";--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" ADD CONSTRAINT "teams_user_agent_preferences_user_id_org_id_pk" PRIMARY KEY USING INDEX "idx_teams_user_agent_preferences_user_org";--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" DROP CONSTRAINT "telegram_user_agent_preferences_pkey";--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" ADD CONSTRAINT "telegram_user_agent_preferences_user_id_org_id_pk" PRIMARY KEY USING INDEX "idx_telegram_user_agent_preferences_user_org";--> statement-breakpoint

DROP INDEX "idx_agentphone_user_links_vm0_org";--> statement-breakpoint
DROP INDEX "idx_feishu_org_connections_vm0_installation";--> statement-breakpoint
DROP INDEX "idx_slack_org_connections_vm0_user_workspace";--> statement-breakpoint
DROP INDEX "idx_teams_org_connections_vm0_tenant";--> statement-breakpoint
DROP INDEX "idx_telegram_official_user_links_vm0_org";--> statement-breakpoint
DROP INDEX "idx_telegram_user_links_vm0_installation";--> statement-breakpoint

-- Drop each known trigger explicitly before its referenced column. The
-- production catalog audit proved that no other dependent object exists.
DROP TRIGGER "sync_agentphone_user_agent_preferences_identity_0930" ON "agentphone_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "sync_agentphone_user_links_identity_0930" ON "agentphone_user_links";--> statement-breakpoint
DROP TRIGGER "sync_feishu_org_connections_identity_0930" ON "feishu_org_connections";--> statement-breakpoint
DROP TRIGGER "sync_feishu_user_agent_preferences_identity_0930" ON "feishu_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "sync_github_user_links_identity_0930" ON "github_user_links";--> statement-breakpoint
DROP TRIGGER "sync_slack_org_connections_identity_0930" ON "slack_org_connections";--> statement-breakpoint
DROP TRIGGER "sync_slack_user_agent_preferences_identity_0930" ON "slack_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "sync_teams_org_connections_identity_0930" ON "teams_org_connections";--> statement-breakpoint
DROP TRIGGER "sync_teams_user_agent_preferences_identity_0930" ON "teams_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "sync_telegram_official_user_links_identity_0930" ON "telegram_official_user_links";--> statement-breakpoint
DROP TRIGGER "sync_telegram_user_agent_preferences_identity_0930" ON "telegram_user_agent_preferences";--> statement-breakpoint
DROP TRIGGER "sync_telegram_user_links_identity_0930" ON "telegram_user_links";--> statement-breakpoint

ALTER TABLE "agentphone_user_agent_preferences" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "agentphone_user_links" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "feishu_org_connections" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "github_user_links" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "slack_org_connections" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "teams_org_connections" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "telegram_official_user_links" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" DROP COLUMN "vm0_user_id";--> statement-breakpoint
ALTER TABLE "telegram_user_links" DROP COLUMN "vm0_user_id";--> statement-breakpoint

DROP FUNCTION "sync_integration_user_identity_0930"();
