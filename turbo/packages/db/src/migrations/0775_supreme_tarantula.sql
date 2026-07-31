CREATE TABLE "browser_session_tab_snapshots" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_tab_urls" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "browser_session_instances" ALTER COLUMN "browser_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "browser_profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_session_tab_snapshots" ADD CONSTRAINT "browser_session_tab_snapshots_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_thread" ON "browser_session_instances" USING btree ("chat_thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
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