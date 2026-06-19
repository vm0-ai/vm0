ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ALTER COLUMN "schedule_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD COLUMN "kind" varchar(16) DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD COLUMN "event_type" varchar(64);--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD COLUMN "type" varchar(16) DEFAULT 'workflow' NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD COLUMN "preference" jsonb;--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_schedule_config_check" CHECK ((
            kind = 'schedule'
            AND event_type IS NULL
            AND (
              (schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
              OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
              OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
            )
          )
          OR (
            kind = 'event'
            AND event_type = 'thread-idle'
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));