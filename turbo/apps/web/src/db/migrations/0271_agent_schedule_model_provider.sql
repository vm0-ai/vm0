ALTER TABLE "zero_agents" ADD COLUMN "model_provider_id" uuid REFERENCES "model_providers"("id") ON DELETE SET NULL;
-->statement-breakpoint
ALTER TABLE "zero_agents" ADD COLUMN "selected_model" varchar(255);
-->statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD COLUMN "model_provider_id" uuid REFERENCES "model_providers"("id") ON DELETE SET NULL;
-->statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD COLUMN "selected_model" varchar(255);
