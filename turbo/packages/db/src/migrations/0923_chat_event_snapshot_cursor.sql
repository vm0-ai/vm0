ALTER TABLE "chat_event_snapshots" ADD COLUMN "last_event_id" uuid;
--> statement-breakpoint
UPDATE "chat_event_snapshots" AS "snapshot"
SET "last_event_id" = (
  SELECT "chat_events"."id"
  FROM "chat_events"
  WHERE "chat_events"."chat_thread_id" = "snapshot"."chat_thread_id"
    AND "chat_events"."seq_id" <= "snapshot"."last_seq_id"
  ORDER BY "chat_events"."seq_id" DESC
  LIMIT 1
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_event_snapshots"
    WHERE "last_event_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'A Chat Event Snapshot has no physical event at or before its cursor';
  END IF;
END;
$$;
--> statement-breakpoint
-- DB/API expand phase: the previous API does not know last_event_id. Populate
-- it for every insert during the observed 102-minute rollout/rollback window,
-- while leaving the physical column nullable. #27174 removes this trigger and
-- adds NOT NULL after the previous API has drained.
CREATE FUNCTION "set_chat_event_snapshot_last_event_id"() RETURNS trigger AS $$
BEGIN
  IF NEW."last_event_id" IS NULL THEN
    SELECT "chat_events"."id"
    INTO NEW."last_event_id"
    FROM "chat_events"
    WHERE "chat_events"."chat_thread_id" = NEW."chat_thread_id"
      AND "chat_events"."seq_id" <= NEW."last_seq_id"
    ORDER BY "chat_events"."seq_id" DESC
    LIMIT 1;
  END IF;

  IF NEW."last_event_id" IS NULL THEN
    RAISE EXCEPTION 'A Chat Event Snapshot has no physical event at or before its cursor';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "chat_event_snapshots_fill_last_event_id"
BEFORE INSERT OR UPDATE OF "last_seq_id" ON "chat_event_snapshots"
FOR EACH ROW EXECUTE FUNCTION "set_chat_event_snapshot_last_event_id"();
