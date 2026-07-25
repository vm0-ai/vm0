ALTER TABLE "slack_chat_ingress" DROP CONSTRAINT "chk_slack_chat_ingress_status";--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" ADD COLUMN "legacy_cutover_event_id" text;--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" ADD COLUMN "legacy_cutover_message_ts" varchar(255);--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD CONSTRAINT "chk_slack_chat_ingress_status" CHECK ("slack_chat_ingress"."status" IN ('pending', 'processing', 'processed', 'ignored', 'failed'));