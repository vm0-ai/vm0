DELETE FROM "workflow_automations" WHERE "event_type" = 'strapi-entry-published';--> statement-breakpoint
ALTER TABLE "strapi_integrations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "strapi_webhook_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_strapi_automations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "strapi_workflow_pending_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "strapi_integrations" CASCADE;--> statement-breakpoint
DROP TABLE "strapi_webhook_deliveries" CASCADE;--> statement-breakpoint
DROP TABLE "workflow_strapi_automations" CASCADE;--> statement-breakpoint
DROP TABLE "strapi_workflow_pending_events" CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_automations" DROP CONSTRAINT "workflow_automations_schedule_config_check";--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD CONSTRAINT "workflow_automations_schedule_config_check" CHECK ((
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
            AND event_type IN ('chat-run-finished', 'gmail-new-message', 'gmail-label-applied', 'github-deployment-status-created', 'github-issue-comment-created', 'github-pull-request', 'github-pull-request-review-submitted', 'github-workflow-job-completed', 'github-workflow-run-completed', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-forms-response-submitted', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'notion-page-content-updated', 'stripe-invoice-paid', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));
