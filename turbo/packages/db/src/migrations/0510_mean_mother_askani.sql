CREATE TABLE "zero_workflow_github_processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"github_delivery_id" varchar(255) NOT NULL,
	"repo" varchar(255) NOT NULL,
	"subject_type" varchar(32) NOT NULL,
	"subject_number" integer NOT NULL,
	"action" varchar(64) NOT NULL,
	"label_name_normalized" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
ALTER TABLE "zero_workflow_github_processed_events" ADD CONSTRAINT "zero_workflow_github_processed_events_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_github_processed_delivery" ON "zero_workflow_github_processed_events" USING btree ("trigger_id","github_delivery_id");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_github_processed_subject" ON "zero_workflow_github_processed_events" USING btree ("repo","subject_type","subject_number");--> statement-breakpoint
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
            AND event_type IN ('gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));