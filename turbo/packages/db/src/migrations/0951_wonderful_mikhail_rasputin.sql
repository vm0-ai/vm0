ALTER TABLE "connector_external_code_sessions" ADD COLUMN "account_mutation" text;--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ADD COLUMN "account_mutation" text;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "account_mutation" text;