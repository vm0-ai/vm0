ALTER TABLE "zero_agent_schedules" DROP CONSTRAINT "zero_agent_schedules_model_provider_id_model_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" DROP COLUMN "model_provider_id";--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" DROP COLUMN "selected_model";--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" DROP COLUMN "prefer_personal_provider";