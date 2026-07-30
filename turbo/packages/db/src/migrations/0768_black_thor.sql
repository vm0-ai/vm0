ALTER TABLE "browser_session_instances" DROP CONSTRAINT "browser_session_instances_usage_event_id_usage_event_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_revokes_message_id_chat_events_id_fk";
--> statement-breakpoint
DROP INDEX "chat_events_revokes_message_id_unique";--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "pending_sequence_numbers" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_result_text" text;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_output_sequence" integer;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_output_text" text;--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "billing_run_id";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "browser_cost_microusd";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "proxy_cost_microusd";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "proxy_used_mb";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "pricing_unit_price";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "pricing_unit_size";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "gross_credits";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "credits_charged";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "usage_event_id";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "settled_at";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "max_credits";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "gross_credits";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "credits_charged";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "revokes_message_id";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "last_chat_message_seq_id";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "first_assistant_message_acknowledged_at";