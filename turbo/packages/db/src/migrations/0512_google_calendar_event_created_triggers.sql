CREATE TABLE "google_calendar_watch_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"channel_token" varchar(255) NOT NULL,
	"resource_id" varchar(255) NOT NULL,
	"resource_uri" text NOT NULL,
	"sync_token" text,
	"watch_expiration_at" timestamp NOT NULL,
	"last_watch_renewed_at" timestamp NOT NULL,
	"needs_rewatch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_calendar_event_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_state_id" uuid NOT NULL,
	"calendar_event_id" varchar(1024) NOT NULL,
	"etag" varchar(255),
	"status" varchar(64),
	"event_type" varchar(64),
	"summary" text,
	"start_at" timestamp,
	"end_at" timestamp,
	"event_created_at" timestamp,
	"event_updated_at" timestamp,
	"snapshot" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_calendar_processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_state_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"resource_state" varchar(64) NOT NULL,
	"calendar_event_id" varchar(1024) NOT NULL,
	"event_created_at" timestamp,
	"event_updated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
ALTER TABLE "google_calendar_watch_states" ADD CONSTRAINT "google_calendar_watch_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_event_snapshots" ADD CONSTRAINT "google_calendar_event_snapshots_watch_state_id_google_calendar_watch_states_id_fk" FOREIGN KEY ("watch_state_id") REFERENCES "public"."google_calendar_watch_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" ADD CONSTRAINT "google_calendar_processed_events_watch_state_id_google_calendar_watch_states_id_fk" FOREIGN KEY ("watch_state_id") REFERENCES "public"."google_calendar_watch_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events" ADD CONSTRAINT "google_calendar_processed_events_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_calendar_watch_states_connector_calendar" ON "google_calendar_watch_states" USING btree ("connector_id","calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_calendar_watch_states_channel" ON "google_calendar_watch_states" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_google_calendar_watch_states_resource" ON "google_calendar_watch_states" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "idx_google_calendar_watch_states_renewal" ON "google_calendar_watch_states" USING btree ("watch_expiration_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_calendar_event_snapshots_event" ON "google_calendar_event_snapshots" USING btree ("watch_state_id","calendar_event_id");--> statement-breakpoint
CREATE INDEX "idx_google_calendar_event_snapshots_updated" ON "google_calendar_event_snapshots" USING btree ("event_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_calendar_processed_events_event" ON "google_calendar_processed_events" USING btree ("watch_state_id","trigger_id","calendar_event_id");--> statement-breakpoint
CREATE INDEX "idx_google_calendar_processed_events_channel" ON "google_calendar_processed_events" USING btree ("channel_id");--> statement-breakpoint
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
            AND event_type IN ('gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'google-calendar-event-created', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));
