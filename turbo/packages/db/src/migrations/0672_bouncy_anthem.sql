ALTER TABLE "model_usage_observation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "model_usage_observation" CASCADE;--> statement-breakpoint
DROP INDEX "uq_model_stat_hour_model_provider";--> statement-breakpoint
ALTER TABLE "model_stat" DROP COLUMN "model_provider";--> statement-breakpoint
ALTER TABLE "model_stat" DROP COLUMN "request_count";--> statement-breakpoint
ALTER TABLE "model_stat" DROP COLUMN "org_count";--> statement-breakpoint
ALTER TABLE "model_stat" DROP COLUMN "user_count";--> statement-breakpoint
ALTER TABLE "model_stat" DROP COLUMN "credits_charged";