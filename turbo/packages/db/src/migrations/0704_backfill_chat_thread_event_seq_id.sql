-- The migration runner commits each migration separately. Rows written by the
-- previous API after the additive migration still have NULL seq_id, so block
-- new writes while this migration backfills every row and installs the legacy
-- write trigger.
LOCK TABLE "chat_thread_events" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- Preserve append-only protection during the backfill. Only this migration's
-- NULL-to-sequence transition is allowed; every other source update remains
-- rejected.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_thread_events'
    AND (to_jsonb(OLD) ->> 'seq_id') IS NULL
    AND (to_jsonb(NEW) ->> 'seq_id') IS NOT NULL
    AND (to_jsonb(NEW) - 'seq_id') = (to_jsonb(OLD) - 'seq_id')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
WITH ordered_events AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, org_id
      ORDER BY created_at ASC, id ASC
    ) AS seq_id
  FROM chat_thread_events
)
UPDATE chat_thread_events AS event
SET seq_id = ordered_events.seq_id
FROM ordered_events
WHERE event.id = ordered_events.id
  AND event.seq_id IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
SELECT event.user_id, event.org_id, MAX(event.seq_id)
FROM chat_thread_events event
GROUP BY event.user_id, event.org_id;--> statement-breakpoint
UPDATE chat_thread_snapshots snapshot
SET latest_event_seq_id = event.seq_id
FROM chat_thread_events event
WHERE event.id = snapshot.latest_event_id
  AND event.user_id = snapshot.user_id
  AND event.org_id = snapshot.org_id;--> statement-breakpoint
-- The previous snapshot compactor advances latest_event_id without knowing
-- about latest_event_seq_id. Fill only the missing companion update so its
-- pruning pass cannot leave a stale sequence cursor behind.
CREATE FUNCTION "fill_legacy_chat_thread_snapshot_event_seq_id"() RETURNS trigger AS $$
BEGIN
  IF NEW.latest_event_id IS NULL THEN
    NEW.latest_event_seq_id := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.latest_event_seq_id IS NULL THEN
      SELECT event.seq_id
      INTO NEW.latest_event_seq_id
      FROM chat_thread_events event
      WHERE event.id = NEW.latest_event_id
        AND event.user_id = NEW.user_id
        AND event.org_id = NEW.org_id;
    END IF;
  ELSIF NEW.latest_event_id IS DISTINCT FROM OLD.latest_event_id
    AND NEW.latest_event_seq_id IS NOT DISTINCT FROM OLD.latest_event_seq_id
  THEN
    SELECT event.seq_id
    INTO NEW.latest_event_seq_id
    FROM chat_thread_events event
    WHERE event.id = NEW.latest_event_id
      AND event.user_id = NEW.user_id
      AND event.org_id = NEW.org_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "fill_legacy_chat_thread_snapshot_event_seq_id"
BEFORE INSERT OR UPDATE ON "chat_thread_snapshots"
FOR EACH ROW EXECUTE FUNCTION "fill_legacy_chat_thread_snapshot_event_seq_id"();--> statement-breakpoint
-- Migrations run before the new API is promoted. Keep the previous API, which
-- omits seq_id, writable until every old and rollback-eligible API instance
-- has drained.
CREATE FUNCTION "allocate_legacy_chat_thread_event_seq_id"() RETURNS trigger AS $$
BEGIN
  IF NEW.seq_id IS NULL THEN
    INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
    VALUES (NEW.user_id, NEW.org_id, 1)
    ON CONFLICT (user_id, org_id)
    DO UPDATE SET
      last_seq_id = chat_thread_event_sequences.last_seq_id + 1
    RETURNING last_seq_id INTO NEW.seq_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "allocate_legacy_chat_thread_event_seq_id"
BEFORE INSERT ON "chat_thread_events"
FOR EACH ROW EXECUTE FUNCTION "allocate_legacy_chat_thread_event_seq_id"();
