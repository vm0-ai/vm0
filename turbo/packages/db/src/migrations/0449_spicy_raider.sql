ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_kind_config_check" CHECK ((kind = 'cron' AND cron_expression IS NOT NULL AND at_time IS NULL AND interval_seconds IS NULL)
          OR (kind = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
          OR (kind = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
          OR (kind = 'webhook' AND webhook_token IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL AND interval_seconds IS NULL));