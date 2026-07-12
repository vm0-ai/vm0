ALTER TABLE "connector_external_code_sessions" ALTER COLUMN "connector_type" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ALTER COLUMN "connector_type" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ALTER COLUMN "type" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "connectors" ALTER COLUMN "type" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "user_connectors" ALTER COLUMN "connector_type" SET DATA TYPE varchar(64);