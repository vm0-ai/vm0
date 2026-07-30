ALTER TABLE "zero_workflow_automations" DROP CONSTRAINT "zero_workflow_automations_schedule_config_check";
ALTER TABLE "zero_workflow_automations" ADD CONSTRAINT "zero_workflow_automations_schedule_config_check" CHECK (
          (
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
            AND event_type IN ('chat-run-finished', 'gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'github-deployment-status-created', 'github-issue-comment-created', 'github-pull-request-review-submitted', 'github-workflow-job-completed', 'github-workflow-run-completed', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'notion-page-content-updated', 'strapi-entry-published', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          )
        );
