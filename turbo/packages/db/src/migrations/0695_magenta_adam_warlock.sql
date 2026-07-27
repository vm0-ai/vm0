ALTER TABLE "slack_org_thread_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "slack_org_thread_sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" DROP CONSTRAINT "chk_slack_chat_ingress_status";--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" DROP CONSTRAINT "chk_slack_chat_thread_routes_backend_thread";--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" ALTER COLUMN "chat_thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" DROP COLUMN "backend";--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" DROP COLUMN "legacy_cutover_event_id";--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" DROP COLUMN "legacy_cutover_message_ts";--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD CONSTRAINT "chk_slack_chat_ingress_status" CHECK ("slack_chat_ingress"."status" IN ('pending', 'processing', 'processed', 'failed'));