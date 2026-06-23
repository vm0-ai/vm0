ALTER TABLE "automation_triggers" DROP CONSTRAINT "automation_triggers_kind_config_check";--> statement-breakpoint
DELETE FROM "automation_triggers" WHERE "kind" = 'webhook';--> statement-breakpoint
DROP INDEX "idx_automation_triggers_webhook_token";--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP COLUMN "webhook_token";--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP COLUMN "encrypted_secret";--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_kind_config_check" CHECK ((kind = 'cron' AND cron_expression IS NOT NULL AND at_time IS NULL AND interval_seconds IS NULL)
          OR (kind = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
          OR (kind = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL));
