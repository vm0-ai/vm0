CREATE TABLE "gmail_processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_state_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"pubsub_message_id" varchar(255),
	"history_id" varchar(64) NOT NULL,
	"message_id" varchar(128) NOT NULL,
	"thread_id" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_watch_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"email_address" varchar(320) NOT NULL,
	"topic_name" text NOT NULL,
	"last_history_id" varchar(64) NOT NULL,
	"watch_expiration_at" timestamp NOT NULL,
	"last_watch_renewed_at" timestamp NOT NULL,
	"needs_rewatch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD COLUMN "event_config" jsonb;--> statement-breakpoint
ALTER TABLE "gmail_processed_events" ADD CONSTRAINT "gmail_processed_events_watch_state_id_gmail_watch_states_id_fk" FOREIGN KEY ("watch_state_id") REFERENCES "public"."gmail_watch_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_processed_events" ADD CONSTRAINT "gmail_processed_events_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_watch_states" ADD CONSTRAINT "gmail_watch_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gmail_processed_events_event" ON "gmail_processed_events" USING btree ("watch_state_id","trigger_id","history_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_gmail_processed_events_pubsub_message" ON "gmail_processed_events" USING btree ("pubsub_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gmail_watch_states_connector_topic" ON "gmail_watch_states" USING btree ("connector_id","topic_name");--> statement-breakpoint
CREATE INDEX "idx_gmail_watch_states_email_topic" ON "gmail_watch_states" USING btree ("email_address","topic_name");--> statement-breakpoint
CREATE INDEX "idx_gmail_watch_states_renewal" ON "gmail_watch_states" USING btree ("watch_expiration_at");--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_schedule_config_check" CHECK ((
            kind = 'schedule'
            AND event_type IS NULL
            AND event_config IS NULL
            AND (
              (schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
              OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
              OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
            )
          )
          OR (
            kind = 'event'
            AND event_type = 'thread-idle'
            AND event_config IS NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          )
          OR (
            kind = 'event'
            AND event_type = 'gmail-new-message'
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));