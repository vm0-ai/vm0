CREATE TABLE "strapi_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"name" varchar(128) NOT NULL,
	"base_url" text NOT NULL,
	"normalized_base_url" text NOT NULL,
	"token_hash" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"secret_last_four" varchar(4) NOT NULL,
	"last_tested_at" timestamp,
	"last_received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strapi_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"body_sha256" text NOT NULL,
	"event" varchar(64) NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strapi_workflow_pending_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"uid" varchar(255) NOT NULL,
	"model" varchar(255) NOT NULL,
	"document_id" varchar(255) NOT NULL,
	"locales" text[] NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"first_event_at" timestamp NOT NULL,
	"latest_event_at" timestamp NOT NULL,
	"run_after" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"skip_reason" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zero_workflow_strapi_automations" (
	"automation_id" uuid PRIMARY KEY NOT NULL,
	"integration_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" DROP CONSTRAINT "zero_workflow_automations_schedule_config_check";--> statement-breakpoint
ALTER TABLE "strapi_webhook_deliveries" ADD CONSTRAINT "strapi_webhook_deliveries_integration_id_strapi_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."strapi_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strapi_workflow_pending_events" ADD CONSTRAINT "strapi_workflow_pending_events_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strapi_workflow_pending_events" ADD CONSTRAINT "strapi_workflow_pending_events_integration_id_strapi_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."strapi_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_workflow_strapi_automations" ADD CONSTRAINT "zero_workflow_strapi_automations_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_workflow_strapi_automations" ADD CONSTRAINT "zero_workflow_strapi_automations_integration_id_strapi_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."strapi_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_strapi_integrations_org" ON "strapi_integrations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_strapi_integrations_org_base_url" ON "strapi_integrations" USING btree ("org_id","normalized_base_url");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_strapi_integrations_token_hash" ON "strapi_integrations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_strapi_webhook_deliveries_integration_body" ON "strapi_webhook_deliveries" USING btree ("integration_id","body_sha256");--> statement-breakpoint
CREATE INDEX "idx_strapi_webhook_deliveries_received" ON "strapi_webhook_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_strapi_pending_events_automation_document_active" ON "strapi_workflow_pending_events" USING btree ("automation_id","uid","document_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_strapi_pending_events_due" ON "strapi_workflow_pending_events" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "idx_strapi_pending_events_integration" ON "strapi_workflow_pending_events" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_strapi_automations_integration" ON "zero_workflow_strapi_automations" USING btree ("integration_id");--> statement-breakpoint
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
            AND event_type IN ('gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'github-deployment-status-created', 'github-issue-comment-created', 'github-pull-request-review-submitted', 'github-workflow-job-completed', 'github-workflow-run-completed', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'notion-page-content-updated', 'strapi-entry-published', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));