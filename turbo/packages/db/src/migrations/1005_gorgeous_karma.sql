ALTER TABLE "connector_external_code_sessions" ADD COLUMN "oauth_requested_scopes" text;--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ADD COLUMN "oauth_requested_scopes" text;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "oauth_requested_scopes" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "oauth_granted_scopes" text;