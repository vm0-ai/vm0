ALTER TABLE "connector_external_code_sessions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "connector_external_code_sessions" ADD COLUMN "authorize_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ADD COLUMN "authorize_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "authorize_agent" boolean DEFAULT false NOT NULL;