CREATE TABLE "google_workspace_event_subscription_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"target_resource" text NOT NULL,
	"event_types" jsonb NOT NULL,
	"event_types_key" text NOT NULL,
	"subscription_name" varchar(255) NOT NULL,
	"pubsub_topic" text NOT NULL,
	"state" varchar(64),
	"expire_time" timestamp NOT NULL,
	"last_renewed_at" timestamp NOT NULL,
	"needs_repair" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_workspace_processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_state_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"pubsub_message_id" varchar(255),
	"cloud_event_id" varchar(255) NOT NULL,
	"cloud_event_type" varchar(255) NOT NULL,
	"conference_record_name" text,
	"transcript_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
ALTER TABLE "google_workspace_event_subscription_states" ADD CONSTRAINT "google_workspace_event_subscription_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" ADD CONSTRAINT "google_workspace_processed_events_subscription_state_id_google_workspace_event_subscription_states_id_fk" FOREIGN KEY ("subscription_state_id") REFERENCES "public"."google_workspace_event_subscription_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events" ADD CONSTRAINT "google_workspace_processed_events_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_workspace_event_subscription_scope" ON "google_workspace_event_subscription_states" USING btree ("connector_id","provider","target_resource","pubsub_topic","event_types_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_workspace_event_subscription_name" ON "google_workspace_event_subscription_states" USING btree ("subscription_name");--> statement-breakpoint
CREATE INDEX "idx_google_workspace_event_subscription_owner" ON "google_workspace_event_subscription_states" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_google_workspace_event_subscription_renewal" ON "google_workspace_event_subscription_states" USING btree ("expire_time");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_workspace_processed_events_cloudevent" ON "google_workspace_processed_events" USING btree ("subscription_state_id","trigger_id","cloud_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_workspace_processed_events_transcript" ON "google_workspace_processed_events" USING btree ("subscription_state_id","trigger_id","transcript_name");--> statement-breakpoint
CREATE INDEX "idx_google_workspace_processed_events_pubsub_message" ON "google_workspace_processed_events" USING btree ("pubsub_message_id");--> statement-breakpoint
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
            AND event_type IN ('gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-meet-transcript-generated', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));