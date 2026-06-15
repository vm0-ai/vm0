CREATE TYPE "public"."connector_cli_auth_session_status" AS ENUM('initializing', 'awaiting_user_approval', 'completing', 'imported', 'expired', 'cancelled', 'error');--> statement-breakpoint
CREATE TABLE "connector_cli_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_type" varchar(50) NOT NULL,
	"source" varchar(50) NOT NULL,
	"status" "connector_cli_auth_session_status" DEFAULT 'initializing' NOT NULL,
	"sandbox_id" varchar(255),
	"approval_url" text,
	"verification_code" varchar(128),
	"encrypted_provider_state" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_connector_cli_auth_sessions_owner_status" ON "connector_cli_auth_sessions" USING btree ("org_id","user_id","connector_type","source","status");--> statement-breakpoint
CREATE INDEX "idx_connector_cli_auth_sessions_expiration" ON "connector_cli_auth_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_connector_cli_auth_sessions_sandbox" ON "connector_cli_auth_sessions" USING btree ("sandbox_id") WHERE "connector_cli_auth_sessions"."sandbox_id" IS NOT NULL;