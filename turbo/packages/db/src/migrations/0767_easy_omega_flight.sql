CREATE TABLE "browser_session_tab_snapshots" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_tab_urls" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP CONSTRAINT "browser_sessions_browser_profile_id_browser_profiles_id_fk";
--> statement-breakpoint
DROP TABLE "browser_profiles" CASCADE;--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP CONSTRAINT "browser_session_instances_browser_session_id_browser_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP CONSTRAINT "browser_session_instances_usage_event_id_usage_event_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP CONSTRAINT "browser_sessions_browser_thread_profile_id_browser_thread_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_revokes_message_id_chat_events_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP CONSTRAINT "browser_sessions_pkey";--> statement-breakpoint
ALTER TABLE "browser_thread_profiles" DROP CONSTRAINT "browser_thread_profiles_pkey";--> statement-breakpoint
DROP INDEX "idx_browser_session_instances_session";--> statement-breakpoint
DROP INDEX "uq_browser_sessions_thread_owned";--> statement-breakpoint
DROP INDEX "uq_browser_thread_profiles_thread";--> statement-breakpoint
DROP INDEX "chat_events_revokes_message_id_unique";--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD PRIMARY KEY ("chat_thread_id");--> statement-breakpoint
ALTER TABLE "browser_thread_profiles" ADD PRIMARY KEY ("chat_thread_id");--> statement-breakpoint
ALTER TABLE "browser_session_tab_snapshots" ADD CONSTRAINT "browser_session_tab_snapshots_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_thread" ON "browser_session_instances" USING btree ("chat_thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "browser_session_id";--> statement-breakpoint
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
ALTER TABLE "browser_sessions" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "browser_profile_id";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "browser_thread_profile_id";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "max_credits";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "gross_credits";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "credits_charged";--> statement-breakpoint
ALTER TABLE "browser_thread_profiles" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "chat_events" DROP COLUMN "revokes_message_id";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "last_chat_message_seq_id";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "first_assistant_message_acknowledged_at";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_event_type_check" CHECK ("chat_events"."event_type" IN (
          'input.prompt',
          'input.automation',
          'input.goal',
          'input.rejected',
          'output.message',
          'output.error',
          'output.thinking',
          'output.followups',
          'run.queued',
          'run.dequeued',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'queue.automation_paused',
          'queue.automation_resumed',
          'control.interrupt',
          'control.revoke',
          'browser.started',
          'browser.stopped',
          'goal.changed',
          'usage.recorded'
        ));
