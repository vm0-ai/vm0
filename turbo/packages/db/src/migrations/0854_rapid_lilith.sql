ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_event_type_check" CHECK ("chat_events"."event_type" IN (
          'input.prompt',
          'input.automation',
          'input.goal',
          'input.budget',
          'input.rejected',
          'output.message',
          'output.error',
          'output.thinking',
          'output.followups',
          'run.queued',
          'run.dequeued',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'control.interrupt',
          'control.revoke',
          'browser.open',
          'browser.close',
          -- Retired physical values still written by the pre-cleanup API while
          -- it drains. Narrow this list to open/close in a later release, once
          -- that API is gone and the rows have been backfilled again.
          'browser.started',
          'browser.stopped',
          'goal.changed',
          'usage.recorded'
        ));--> statement-breakpoint
-- The API no longer accepts the retired zh-CN preference, so converge stored
-- rows onto the default locale. The pre-cleanup API still accepts en-US, so
-- this stays safe while that release drains.
UPDATE "org_members_metadata"
SET "locale" = 'en-US'
WHERE "locale" = 'zh-CN';
