CREATE TYPE "public"."connector_external_code_session_status" AS ENUM('pending', 'completing', 'complete', 'expired', 'error');--> statement-breakpoint
CREATE TABLE "connector_external_code_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_type" varchar(50) NOT NULL,
	"auth_method" varchar(50) NOT NULL,
	"status" "connector_external_code_session_status" DEFAULT 'pending' NOT NULL,
	"session_token_hash" varchar(128) NOT NULL,
	"encrypted_provider_state" text NOT NULL,
	"authorization_url" text NOT NULL,
	"error_code" varchar(255),
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connector_external_code_sessions_token" ON "connector_external_code_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "idx_connector_external_code_sessions_owner_status" ON "connector_external_code_sessions" USING btree ("org_id","user_id","connector_type","auth_method","status");--> statement-breakpoint
CREATE INDEX "idx_connector_external_code_sessions_expiration" ON "connector_external_code_sessions" USING btree ("status","expires_at");