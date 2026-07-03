DROP TABLE "connector_sessions";--> statement-breakpoint
ALTER TABLE "connector_oauth_states" DROP COLUMN "session_id";--> statement-breakpoint
DROP TYPE "public"."connector_session_status";
