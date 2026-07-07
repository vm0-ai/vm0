ALTER TABLE "notion_workflow_pending_events" ADD COLUMN "scope_type" varchar(32);
ALTER TABLE "notion_workflow_pending_events" ADD COLUMN "scope_id" uuid;
UPDATE "notion_workflow_pending_events"
SET "scope_type" = 'page',
    "scope_id" = "parent_page_id";
ALTER TABLE "notion_workflow_pending_events" ALTER COLUMN "scope_type" SET NOT NULL;
ALTER TABLE "notion_workflow_pending_events" ALTER COLUMN "scope_id" SET NOT NULL;
ALTER TABLE "notion_workflow_pending_events" DROP COLUMN "parent_page_id";
CREATE INDEX "idx_notion_pending_events_scope" ON "notion_workflow_pending_events" USING btree ("scope_type","scope_id");

ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_schedule_config_check" CHECK (
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
            AND event_type IN ('gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          )
        );
