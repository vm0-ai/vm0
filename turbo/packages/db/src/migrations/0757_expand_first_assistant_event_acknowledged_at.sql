LOCK TABLE "zero_runs" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

ALTER TABLE "zero_runs" ADD COLUMN "first_assistant_event_acknowledged_at" timestamp;--> statement-breakpoint

UPDATE "zero_runs"
SET "first_assistant_event_acknowledged_at" =
  "first_assistant_message_acknowledged_at"
WHERE "first_assistant_event_acknowledged_at"
  IS DISTINCT FROM "first_assistant_message_acknowledged_at";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "zero_runs"
    WHERE "first_assistant_event_acknowledged_at"
      IS DISTINCT FROM "first_assistant_message_acknowledged_at"
  ) THEN
    RAISE EXCEPTION
      'Cannot establish canonical first_assistant_event_acknowledged_at storage';
  END IF;
END;
$$;--> statement-breakpoint

-- Both releases can set or clear their timestamp. Detect which side changed and
-- mirror that value so old SELECT/RETURNING lists and new reads agree.
CREATE FUNCTION "bridge_zero_run_first_assistant_event_ack_0757"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."first_assistant_event_acknowledged_at" IS NULL THEN
      NEW."first_assistant_event_acknowledged_at" :=
        NEW."first_assistant_message_acknowledged_at";
    ELSIF NEW."first_assistant_message_acknowledged_at" IS NULL THEN
      NEW."first_assistant_message_acknowledged_at" :=
        NEW."first_assistant_event_acknowledged_at";
    ELSIF NEW."first_assistant_event_acknowledged_at"
      IS DISTINCT FROM NEW."first_assistant_message_acknowledged_at"
    THEN
      RAISE EXCEPTION 'zero run first-assistant acknowledgement columns must match';
    END IF;
  ELSIF NEW."first_assistant_event_acknowledged_at"
      IS DISTINCT FROM OLD."first_assistant_event_acknowledged_at"
    AND NEW."first_assistant_message_acknowledged_at"
      IS DISTINCT FROM OLD."first_assistant_message_acknowledged_at"
    AND NEW."first_assistant_event_acknowledged_at"
      IS DISTINCT FROM NEW."first_assistant_message_acknowledged_at"
  THEN
    RAISE EXCEPTION 'zero run first-assistant acknowledgement columns must match';
  ELSIF NEW."first_assistant_message_acknowledged_at"
      IS DISTINCT FROM OLD."first_assistant_message_acknowledged_at"
  THEN
    NEW."first_assistant_event_acknowledged_at" :=
      NEW."first_assistant_message_acknowledged_at";
  ELSIF NEW."first_assistant_event_acknowledged_at"
      IS DISTINCT FROM OLD."first_assistant_event_acknowledged_at"
  THEN
    NEW."first_assistant_message_acknowledged_at" :=
      NEW."first_assistant_event_acknowledged_at";
  ELSIF NEW."first_assistant_event_acknowledged_at"
      IS DISTINCT FROM NEW."first_assistant_message_acknowledged_at"
  THEN
    RAISE EXCEPTION 'zero run first-assistant acknowledgement columns must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_zero_run_first_assistant_event_ack_0757"
BEFORE INSERT OR UPDATE ON "zero_runs"
FOR EACH ROW
EXECUTE FUNCTION "bridge_zero_run_first_assistant_event_ack_0757"();
