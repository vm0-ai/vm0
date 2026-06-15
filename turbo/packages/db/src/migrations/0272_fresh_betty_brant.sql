ALTER TABLE "zero_agent_schedules" ADD COLUMN "model_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD COLUMN "selected_model" varchar(255);--> statement-breakpoint
ALTER TABLE "zero_agents" ADD COLUMN "model_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_agents" ADD COLUMN "selected_model" varchar(255);--> statement-breakpoint
ALTER TABLE "zero_agent_schedules" ADD CONSTRAINT "zero_agent_schedules_model_provider_id_model_providers_id_fk" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_agents" ADD CONSTRAINT "zero_agents_model_provider_id_model_providers_id_fk" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;