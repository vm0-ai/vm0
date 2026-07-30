ALTER TABLE "connector_external_code_sessions" ALTER COLUMN "connector_slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ALTER COLUMN "connector_slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_connectors" ALTER COLUMN "connector_slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permission_grants" ALTER COLUMN "connector_slug" SET NOT NULL;