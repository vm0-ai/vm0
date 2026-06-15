ALTER TYPE "public"."connector_cli_auth_session_status" RENAME TO "model_provider_auth_session_status";--> statement-breakpoint
ALTER TABLE "connector_cli_auth_sessions" RENAME TO "model_provider_auth_sessions";--> statement-breakpoint
ALTER TABLE "model_provider_auth_sessions" RENAME CONSTRAINT "connector_cli_auth_sessions_pkey" TO "model_provider_auth_sessions_pkey";--> statement-breakpoint
ALTER INDEX "idx_connector_cli_auth_sessions_owner_status" RENAME TO "idx_model_provider_auth_sessions_owner_status";--> statement-breakpoint
ALTER INDEX "idx_connector_cli_auth_sessions_expiration" RENAME TO "idx_model_provider_auth_sessions_expiration";--> statement-breakpoint
ALTER INDEX "idx_connector_cli_auth_sessions_sandbox" RENAME TO "idx_model_provider_auth_sessions_sandbox";--> statement-breakpoint
CREATE VIEW "public"."connector_cli_auth_sessions" AS (
  SELECT
    "id",
    "org_id",
    "user_id",
    "connector_type",
    "source",
    "status",
    "sandbox_id",
    "approval_url",
    "verification_code",
    "encrypted_provider_state",
    "error_message",
    "created_at",
    "updated_at",
    "expires_at",
    "completed_at",
    "cancelled_at"
  FROM "model_provider_auth_sessions"
);
