-- Keep the physical table available to both releases. The previous API uses
-- conflict targets on chat_events, so an aliased compatibility view cannot
-- preserve its INSERT shapes.
LOCK TABLE "chat_events" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

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

ALTER TABLE "chat_events" ADD COLUMN "revokes_event_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_revokes_event_id_chat_events_id_fk" FOREIGN KEY ("revokes_event_id") REFERENCES "public"."chat_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Keep append-only protection installed while narrowly permitting the
-- canonical pointer to be copied from its legacy twin.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND NEW."revokes_event_id" IS NOT DISTINCT FROM OLD."revokes_message_id"
    AND (to_jsonb(NEW) - 'revokes_event_id')
      = (to_jsonb(OLD) - 'revokes_event_id')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

UPDATE "chat_events"
SET "revokes_event_id" = "revokes_message_id"
WHERE "revokes_event_id" IS DISTINCT FROM "revokes_message_id";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events"
    WHERE "revokes_event_id" IS DISTINCT FROM "revokes_message_id"
  ) THEN
    RAISE EXCEPTION 'Cannot establish canonical revokes_event_id storage';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Old releases write revokes_message_id while the new release writes
-- revokes_event_id. Mirror inserts in both directions without ever updating an
-- existing ChatEvent.
CREATE FUNCTION "bridge_chat_event_revokes_event_id_0755"() RETURNS trigger AS $$
BEGIN
  IF NEW."revokes_event_id" IS NULL THEN
    NEW."revokes_event_id" := NEW."revokes_message_id";
  ELSIF NEW."revokes_message_id" IS NULL THEN
    NEW."revokes_message_id" := NEW."revokes_event_id";
  ELSIF NEW."revokes_event_id" IS DISTINCT FROM NEW."revokes_message_id" THEN
    RAISE EXCEPTION 'chat event revoke columns must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_chat_event_revokes_event_id_0755"
BEFORE INSERT ON "chat_events"
FOR EACH ROW
EXECUTE FUNCTION "bridge_chat_event_revokes_event_id_0755"();--> statement-breakpoint

-- Preserve the legacy conflict target and install the canonical unique index
-- before the next release starts issuing canonical conflict targets.
CREATE UNIQUE INDEX "chat_events_revokes_event_id_unique" ON "chat_events" USING btree ("revokes_event_id");
