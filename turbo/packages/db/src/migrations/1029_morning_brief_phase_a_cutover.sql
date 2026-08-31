-- Phase A keeps the legacy tables readable while making every outgoing legacy
-- writer terminal during the DB-before-API rolling deployment window.
CREATE OR REPLACE FUNCTION "force_legacy_morning_brief_disabled_1029"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."morning_brief_enabled" := false;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "force_legacy_morning_brief_disabled_1029" ON "org_members_metadata";
--> statement-breakpoint
CREATE TRIGGER "force_legacy_morning_brief_disabled_1029"
BEFORE INSERT OR UPDATE OF "morning_brief_enabled" ON "org_members_metadata"
FOR EACH ROW
EXECUTE FUNCTION "force_legacy_morning_brief_disabled_1029"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pause_legacy_morning_brief_schedule_1029"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."next_run_at" := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pause_legacy_morning_brief_schedule_1029" ON "morning_brief_schedules";
--> statement-breakpoint
CREATE TRIGGER "pause_legacy_morning_brief_schedule_1029"
BEFORE INSERT OR UPDATE OF "next_run_at" ON "morning_brief_schedules"
FOR EACH ROW
EXECUTE FUNCTION "pause_legacy_morning_brief_schedule_1029"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_legacy_morning_brief_delivery_1029"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IN ('collecting', 'queued', 'running') THEN
    RAISE EXCEPTION 'legacy Morning Brief delivery admission is retired'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reject_legacy_morning_brief_delivery_1029" ON "morning_brief_deliveries";
--> statement-breakpoint
CREATE TRIGGER "reject_legacy_morning_brief_delivery_1029"
BEFORE INSERT OR UPDATE OF "status", "run_id", "input_key", "output_key" ON "morning_brief_deliveries"
FOR EACH ROW
EXECUTE FUNCTION "reject_legacy_morning_brief_delivery_1029"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_legacy_morning_brief_context_1029"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'legacy Morning Brief queue admission is retired'
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reject_legacy_morning_brief_context_1029" ON "chat_morning_brief_context";
--> statement-breakpoint
CREATE TRIGGER "reject_legacy_morning_brief_context_1029"
BEFORE INSERT ON "chat_morning_brief_context"
FOR EACH ROW
EXECUTE FUNCTION "reject_legacy_morning_brief_context_1029"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_legacy_morning_brief_email_1029"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."template" ->> 'template' = 'morning-brief' THEN
    RAISE EXCEPTION 'legacy Morning Brief email admission is retired'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reject_legacy_morning_brief_email_1029" ON "email_outbox";
--> statement-breakpoint
CREATE TRIGGER "reject_legacy_morning_brief_email_1029"
BEFORE INSERT ON "email_outbox"
FOR EACH ROW
EXECUTE FUNCTION "reject_legacy_morning_brief_email_1029"();
--> statement-breakpoint
UPDATE "org_members_metadata"
SET "morning_brief_enabled" = false
WHERE "morning_brief_enabled" IS DISTINCT FROM false;
--> statement-breakpoint
UPDATE "morning_brief_schedules"
SET "next_run_at" = NULL
WHERE "next_run_at" IS NOT NULL;

-- All five functions and triggers are temporary rolling-compatibility
-- fallbacks. Phase B removes them only after #30264's released zero-traffic
-- observation gate excludes outgoing/rollback legacy API writers and legacy
-- queued/callback work.
