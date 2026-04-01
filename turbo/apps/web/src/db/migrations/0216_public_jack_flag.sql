ALTER TABLE "zero_runs" ADD COLUMN "model_provider" varchar(100);--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "selected_model" varchar(255);--> statement-breakpoint
UPDATE "zero_runs" SET "model_provider" = "ar"."model_provider", "selected_model" = "ar"."selected_model" FROM "agent_runs" "ar" WHERE "zero_runs"."id" = "ar"."id";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "model_provider";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "selected_model";