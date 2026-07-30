LOCK TABLE "chat_threads" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

ALTER TABLE "chat_threads" ADD COLUMN "last_chat_event_seq_id" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

UPDATE "chat_threads"
SET "last_chat_event_seq_id" = "last_chat_message_seq_id"
WHERE "last_chat_event_seq_id" IS DISTINCT FROM "last_chat_message_seq_id";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_threads"
    WHERE "last_chat_event_seq_id" IS DISTINCT FROM "last_chat_message_seq_id"
  ) THEN
    RAISE EXCEPTION 'Cannot establish canonical last_chat_event_seq_id storage';
  END IF;
END;
$$;--> statement-breakpoint

-- Persisted allocators and the draining API write last_chat_message_seq_id;
-- the new API writes last_chat_event_seq_id. Detect the side changed by an
-- UPDATE and keep both values identical, including explicit resets.
CREATE FUNCTION "bridge_chat_thread_last_chat_event_seq_id_0756"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."last_chat_event_seq_id" IS NULL THEN
      NEW."last_chat_event_seq_id" := NEW."last_chat_message_seq_id";
    ELSIF NEW."last_chat_message_seq_id" IS NULL THEN
      NEW."last_chat_message_seq_id" := NEW."last_chat_event_seq_id";
    ELSIF NEW."last_chat_event_seq_id"
      IS NOT DISTINCT FROM NEW."last_chat_message_seq_id"
    THEN
      RETURN NEW;
    ELSIF NEW."last_chat_event_seq_id" = 0 THEN
      NEW."last_chat_event_seq_id" := NEW."last_chat_message_seq_id";
    ELSIF NEW."last_chat_message_seq_id" = 0 THEN
      NEW."last_chat_message_seq_id" := NEW."last_chat_event_seq_id";
    ELSE
      RAISE EXCEPTION 'chat thread event sequence columns must match';
    END IF;
  ELSIF NEW."last_chat_event_seq_id"
      IS DISTINCT FROM OLD."last_chat_event_seq_id"
    AND NEW."last_chat_message_seq_id"
      IS DISTINCT FROM OLD."last_chat_message_seq_id"
    AND NEW."last_chat_event_seq_id"
      IS DISTINCT FROM NEW."last_chat_message_seq_id"
  THEN
    RAISE EXCEPTION 'chat thread event sequence columns must match';
  ELSIF NEW."last_chat_message_seq_id"
      IS DISTINCT FROM OLD."last_chat_message_seq_id"
  THEN
    NEW."last_chat_event_seq_id" := NEW."last_chat_message_seq_id";
  ELSIF NEW."last_chat_event_seq_id"
      IS DISTINCT FROM OLD."last_chat_event_seq_id"
  THEN
    NEW."last_chat_message_seq_id" := NEW."last_chat_event_seq_id";
  ELSIF NEW."last_chat_event_seq_id"
      IS DISTINCT FROM NEW."last_chat_message_seq_id"
  THEN
    RAISE EXCEPTION 'chat thread event sequence columns must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_chat_thread_last_chat_event_seq_id_0756"
BEFORE INSERT OR UPDATE ON "chat_threads"
FOR EACH ROW
EXECUTE FUNCTION "bridge_chat_thread_last_chat_event_seq_id_0756"();
