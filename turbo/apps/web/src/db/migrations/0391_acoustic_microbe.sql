CREATE TYPE "public"."connector_oauth_device_authorization_session_status" AS ENUM('awaiting_user_authorization', 'polling', 'complete', 'denied', 'expired', 'error');--> statement-breakpoint
CREATE TABLE "connector_oauth_device_authorization_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_type" varchar(50) NOT NULL,
	"status" "connector_oauth_device_authorization_session_status" DEFAULT 'awaiting_user_authorization' NOT NULL,
	"session_token_hash" varchar(128) NOT NULL,
	"encrypted_provider_state" text NOT NULL,
	"user_code" varchar(255) NOT NULL,
	"verification_uri" text NOT NULL,
	"verification_uri_complete" text,
	"interval_seconds" integer NOT NULL,
	"error_code" varchar(255),
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connector_oauth_device_authorization_sessions_token" ON "connector_oauth_device_authorization_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "idx_connector_oauth_device_authorization_sessions_owner_status" ON "connector_oauth_device_authorization_sessions" USING btree ("org_id","user_id","connector_type","status");--> statement-breakpoint
CREATE INDEX "idx_connector_oauth_device_authorization_sessions_expiration" ON "connector_oauth_device_authorization_sessions" USING btree ("status","expires_at");