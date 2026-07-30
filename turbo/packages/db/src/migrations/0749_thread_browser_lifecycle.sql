SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE
  "browser_session_instances",
  "browser_sessions",
  "chat_events"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

-- The browser preview previously allowed a suspended session to be superseded
-- by another row for the same thread. Keep the live row when one exists;
-- otherwise keep the most recently created row before enforcing one-to-one.
WITH "ranked_browser_sessions" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "chat_thread_id"
      ORDER BY
        ("status" IN ('creating', 'active', 'resuming', 'stopping')) DESC,
        "created_at" DESC,
        "id" DESC
    ) AS "row_number"
  FROM "browser_sessions"
)
DELETE FROM "browser_sessions"
USING "ranked_browser_sessions"
WHERE "browser_sessions"."id" = "ranked_browser_sessions"."id"
  AND "ranked_browser_sessions"."row_number" > 1;--> statement-breakpoint

ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
DROP INDEX "uq_browser_sessions_thread_owned";--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_thread" ON "browser_session_instances" USING btree ("chat_thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_sessions_thread" ON "browser_sessions" USING btree ("chat_thread_id");--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_event_type_check" CHECK ("chat_events"."event_type" IN (
          'input.prompt',
          'input.automation',
          'input.goal',
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
          'queue.automation_paused',
          'queue.automation_resumed',
          'control.interrupt',
          'control.revoke',
          'browser.started',
          'browser.stopped',
          'goal.changed',
          'usage.recorded'
        ));
