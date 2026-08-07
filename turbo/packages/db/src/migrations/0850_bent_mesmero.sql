ALTER TABLE "browser_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "image_artifact_edit_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP CONSTRAINT "browser_session_instances_browser_session_id_browser_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP CONSTRAINT "browser_sessions_browser_profile_id_browser_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP CONSTRAINT "browser_sessions_browser_thread_profile_id_browser_thread_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "mail_drafts" DROP CONSTRAINT "mail_drafts_follow_up_automation_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP CONSTRAINT "browser_sessions_pkey";--> statement-breakpoint
ALTER TABLE "browser_thread_profiles" DROP CONSTRAINT "browser_thread_profiles_pkey";--> statement-breakpoint
DROP TABLE "browser_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "image_artifact_edit_snapshots" CASCADE;--> statement-breakpoint
DROP INDEX "idx_browser_session_instances_session";--> statement-breakpoint
DROP INDEX "uq_browser_sessions_thread_owned";--> statement-breakpoint
DROP INDEX "uq_browser_thread_profiles_thread";--> statement-breakpoint
DROP INDEX "idx_mail_drafts_follow_up_automation";--> statement-breakpoint
WITH "ranked_browser_sessions" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "chat_thread_id"
      ORDER BY
        CASE
          WHEN "status" IN ('creating', 'active', 'resuming', 'stopping') THEN 0
          ELSE 1
        END,
        "updated_at" DESC,
        "created_at" DESC,
        "id" DESC
    ) AS "row_number"
  FROM "browser_sessions"
)
DELETE FROM "browser_sessions"
USING "ranked_browser_sessions"
WHERE "browser_sessions"."id" = "ranked_browser_sessions"."id"
  AND "ranked_browser_sessions"."row_number" > 1;--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "browser_session_id";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "browser_profile_id";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "browser_thread_profile_id";--> statement-breakpoint
ALTER TABLE "browser_thread_profiles" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "mail_drafts" DROP COLUMN "draft";--> statement-breakpoint
ALTER TABLE "mail_drafts" DROP COLUMN "follow_up_automation_id";--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD PRIMARY KEY ("chat_thread_id");--> statement-breakpoint
ALTER TABLE "browser_thread_profiles" ADD PRIMARY KEY ("chat_thread_id");--> statement-breakpoint
UPDATE "org_members_metadata"
SET "locale" = 'en-US'
WHERE "locale" = 'zh-CN';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND "tgenabled" <> 'D'
  ) THEN
    RAISE EXCEPTION 'chat_events append-only trigger must be enabled';
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND (
      (OLD."event_type" = 'browser.started' AND NEW."event_type" = 'browser.open')
      OR (OLD."event_type" = 'browser.stopped' AND NEW."event_type" = 'browser.close')
    )
    AND (to_jsonb(NEW) - 'event_type') = (to_jsonb(OLD) - 'event_type')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
UPDATE "chat_events"
SET "event_type" = 'browser.open'
WHERE "event_type" = 'browser.started';--> statement-breakpoint
UPDATE "chat_events"
SET "event_type" = 'browser.close'
WHERE "event_type" = 'browser.stopped';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events"
    WHERE "event_type" IN ('browser.started', 'browser.stopped')
  ) THEN
    RAISE EXCEPTION 'Retired browser lifecycle chat events remain';
  END IF;
END;
$$;--> statement-breakpoint
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
          'goal.changed',
          'usage.recorded'
        ));
