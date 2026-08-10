ALTER TABLE "insights_daily" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_daily" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "insights_daily" CASCADE;--> statement-breakpoint
DROP TABLE "usage_daily" CASCADE;--> statement-breakpoint
DROP INDEX "idx_agent_runs_completed_org_user";