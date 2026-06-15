TRUNCATE TABLE "usage_daily";--> statement-breakpoint
DROP INDEX "uq_usage_daily_user_date";--> statement-breakpoint
ALTER TABLE "usage_daily" ADD COLUMN "org_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_daily_user_org_date" ON "usage_daily" USING btree ("user_id","org_id","date");