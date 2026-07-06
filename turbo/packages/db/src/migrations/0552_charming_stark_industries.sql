CREATE TABLE "notion_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notion_event_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"page_id" uuid,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notion_webhook_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid,
	"encrypted_verification_token" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notion_workflow_pending_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"parent_page_id" uuid NOT NULL,
	"event_family" varchar(64) DEFAULT 'new_child_page' NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"first_notion_event_id" uuid NOT NULL,
	"latest_notion_event_id" uuid NOT NULL,
	"first_event_at" timestamp NOT NULL,
	"latest_event_at" timestamp NOT NULL,
	"run_after" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"page_title" text,
	"page_url" text,
	"parent_title" text,
	"parent_url" text,
	"skip_reason" text,
	"last_error" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events" ADD CONSTRAINT "notion_workflow_pending_events_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notion_webhook_events_event_id" ON "notion_webhook_events" USING btree ("notion_event_id");--> statement-breakpoint
CREATE INDEX "idx_notion_webhook_events_page" ON "notion_webhook_events" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_notion_webhook_secrets_active" ON "notion_webhook_secrets" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notion_webhook_secrets_active_single" ON "notion_webhook_secrets" USING btree ("active") WHERE active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notion_pending_events_trigger_page_family" ON "notion_workflow_pending_events" USING btree ("trigger_id","page_id","event_family");--> statement-breakpoint
CREATE INDEX "idx_notion_pending_events_due" ON "notion_workflow_pending_events" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "idx_notion_pending_events_page_pending" ON "notion_workflow_pending_events" USING btree ("page_id","status");--> statement-breakpoint
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
            AND event_type IN ('gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-meet-transcript-generated', 'notion-child-page-created', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));