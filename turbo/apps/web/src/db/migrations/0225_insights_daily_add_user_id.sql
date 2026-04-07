ALTER TABLE "insights_daily" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
DROP INDEX "uq_insights_daily_org_date";--> statement-breakpoint
DROP INDEX "idx_insights_daily_org_date_desc";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_insights_daily_org_user_date" ON "insights_daily" USING btree ("org_id","user_id","date");--> statement-breakpoint
CREATE INDEX "idx_insights_daily_org_user_date_desc" ON "insights_daily" USING btree ("org_id","user_id","date" DESC NULLS LAST);
