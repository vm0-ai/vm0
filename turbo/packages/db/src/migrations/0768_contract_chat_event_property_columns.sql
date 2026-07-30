-- Release 3 contracts the dual-column compatibility window only after the
-- canonical runtime and its rollback predecessor have drained.
LOCK TABLE "chat_events", "chat_threads", "zero_runs"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

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

-- The persisted allocator from migration 0659 still runs for ChatEvent inserts
-- without an explicit seq_id. Retarget it before removing the legacy counter.
CREATE OR REPLACE FUNCTION "allocate_legacy_chat_message_seq_id"()
RETURNS trigger AS $$
BEGIN
  IF NEW."seq_id" IS NULL THEN
    UPDATE "chat_threads"
    SET "last_chat_event_seq_id" = "last_chat_event_seq_id" + 1
    WHERE "id" = NEW."chat_thread_id"
    RETURNING "last_chat_event_seq_id" INTO NEW."seq_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER "bridge_chat_event_revokes_event_id_0755"
ON "chat_events";--> statement-breakpoint
DROP FUNCTION "bridge_chat_event_revokes_event_id_0755"();--> statement-breakpoint

DROP TRIGGER "bridge_chat_thread_last_chat_event_seq_id_0756"
ON "chat_threads";--> statement-breakpoint
DROP FUNCTION "bridge_chat_thread_last_chat_event_seq_id_0756"();--> statement-breakpoint

DROP TRIGGER "bridge_zero_run_first_assistant_event_ack_0757"
ON "zero_runs";--> statement-breakpoint
DROP FUNCTION "bridge_zero_run_first_assistant_event_ack_0757"();--> statement-breakpoint

DROP INDEX "chat_events_revokes_message_id_unique";--> statement-breakpoint
ALTER TABLE "chat_events"
DROP CONSTRAINT "chat_events_revokes_message_id_chat_events_id_fk";--> statement-breakpoint

ALTER TABLE "chat_events"
DROP COLUMN "revokes_message_id";--> statement-breakpoint
ALTER TABLE "chat_threads"
DROP COLUMN "last_chat_message_seq_id";--> statement-breakpoint
ALTER TABLE "zero_runs"
DROP COLUMN "first_assistant_message_acknowledged_at";--> statement-breakpoint

-- Migration 0765 restored this exact strict definition after its backfill.
-- Reassert it after contraction so no compatibility exemption can survive.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND "tgenabled" <> 'D'
      AND "tgfoid" = 'public.reject_chat_event_source_update()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'strict chat_events append-only trigger must remain enabled';
  END IF;
END;
$$;
