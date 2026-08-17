-- Re-run the Expand backfill idempotently immediately before closing the
-- canonical column's nullability window.
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

-- Fail closed if the Expand invariant was violated before making user_id
-- canonical and non-nullable.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "agentphone_user_agent_preferences" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "agentphone_user_links" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "feishu_org_connections" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "feishu_user_agent_preferences" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "github_user_links" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "slack_org_connections" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "slack_user_agent_preferences" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "teams_org_connections" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "teams_user_agent_preferences" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "telegram_official_user_links" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "telegram_user_agent_preferences" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
		UNION ALL
		SELECT 1 FROM "telegram_user_links" WHERE "user_id" IS DISTINCT FROM "vm0_user_id"
	) THEN
		RAISE EXCEPTION 'integration identity expansion contains null or mismatched values'
			USING ERRCODE = '23514';
	END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "agentphone_user_agent_preferences" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agentphone_user_links" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "github_user_links" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_org_connections" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams_org_connections" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_official_user_links" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_user_links" ALTER COLUMN "user_id" SET NOT NULL;
