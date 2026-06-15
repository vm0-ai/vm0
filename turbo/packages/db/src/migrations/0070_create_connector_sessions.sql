-- Connector sessions table for CLI device flow
-- Tracks pending OAuth connections initiated from CLI

-- Create enum for session status
CREATE TYPE "connector_session_status" AS ENUM ('pending', 'complete', 'expired', 'error');
--> statement-breakpoint

-- Create connector_sessions table
CREATE TABLE "connector_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(9) NOT NULL,
  "type" varchar(50) NOT NULL,
  "user_id" text NOT NULL,
  "status" "connector_session_status" DEFAULT 'pending' NOT NULL,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp NOT NULL,
  "completed_at" timestamp
);
--> statement-breakpoint

-- Create unique index on code
CREATE UNIQUE INDEX "idx_connector_sessions_code" ON "connector_sessions" USING btree ("code");
--> statement-breakpoint

-- Create index for user lookups
CREATE INDEX "idx_connector_sessions_user_status" ON "connector_sessions" USING btree ("user_id", "status");
