ALTER TABLE "connector_oauth_device_authorization_sessions" ADD COLUMN "auth_method" varchar(50);--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "auth_method" varchar(50);--> statement-breakpoint
ALTER TABLE "connector_sessions" ADD COLUMN "auth_method" varchar(50);--> statement-breakpoint
UPDATE "connector_oauth_device_authorization_sessions" SET "auth_method" = 'oauth' WHERE "auth_method" IS NULL;--> statement-breakpoint
UPDATE "connector_oauth_states" SET "auth_method" = 'oauth' WHERE "auth_method" IS NULL;--> statement-breakpoint
UPDATE "connector_sessions" SET "auth_method" = 'oauth' WHERE "auth_method" IS NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ALTER COLUMN "auth_method" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ALTER COLUMN "auth_method" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_sessions" ALTER COLUMN "auth_method" SET NOT NULL;
