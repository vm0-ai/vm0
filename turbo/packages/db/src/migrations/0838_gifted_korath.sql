CREATE TABLE "google_forms_automation_cursors" (
	"automation_id" uuid PRIMARY KEY NOT NULL,
	"watch_state_id" uuid NOT NULL,
	"last_seen_submitted_time" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_forms_processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_state_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"pubsub_message_id" varchar(255) NOT NULL,
	"response_id" varchar(255) NOT NULL,
	"last_submitted_time" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_forms_watch_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"form_id" text NOT NULL,
	"watch_id" varchar(255) NOT NULL,
	"topic_name" text NOT NULL,
	"expire_time" timestamp NOT NULL,
	"last_renewed_at" timestamp NOT NULL,
	"needs_rewatch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" DROP CONSTRAINT "zero_workflow_automations_schedule_config_check";--> statement-breakpoint
ALTER TABLE "google_forms_automation_cursors" ADD CONSTRAINT "google_forms_automation_cursors_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_forms_automation_cursors" ADD CONSTRAINT "google_forms_automation_cursors_watch_state_id_google_forms_watch_states_id_fk" FOREIGN KEY ("watch_state_id") REFERENCES "public"."google_forms_watch_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_forms_processed_events" ADD CONSTRAINT "google_forms_processed_events_watch_state_id_google_forms_watch_states_id_fk" FOREIGN KEY ("watch_state_id") REFERENCES "public"."google_forms_watch_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_forms_processed_events" ADD CONSTRAINT "google_forms_processed_events_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_forms_watch_states" ADD CONSTRAINT "google_forms_watch_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_google_forms_automation_cursors_watch" ON "google_forms_automation_cursors" USING btree ("watch_state_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_forms_processed_events_automation_response" ON "google_forms_processed_events" USING btree ("watch_state_id","automation_id","response_id","last_submitted_time");--> statement-breakpoint
CREATE INDEX "idx_google_forms_processed_events_pubsub_message" ON "google_forms_processed_events" USING btree ("pubsub_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_forms_watch_states_form_user" ON "google_forms_watch_states" USING btree ("form_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_google_forms_watch_states_watch" ON "google_forms_watch_states" USING btree ("watch_id");--> statement-breakpoint
CREATE INDEX "idx_google_forms_watch_states_renewal" ON "google_forms_watch_states" USING btree ("expire_time");--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD CONSTRAINT "zero_workflow_automations_schedule_config_check" CHECK ((
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
            AND event_type IN ('chat-run-finished', 'gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'github-deployment-status-created', 'github-issue-comment-created', 'github-pull-request-review-submitted', 'github-workflow-job-completed', 'github-workflow-run-completed', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-forms-response-submitted', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'notion-page-content-updated', 'strapi-entry-published', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));