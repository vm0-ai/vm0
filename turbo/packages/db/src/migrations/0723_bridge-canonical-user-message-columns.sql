-- Block writes while canonical columns are backfilled and the rolling-deploy
-- bridges are installed.
LOCK TABLE "chat_messages", "chat_threads", "zero_agent_drafts"
IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- Keep append-only protection installed throughout the chat event backfill.
-- This migration may update only the new canonical column and retire the
-- legacy input content projection.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_messages'
    AND (to_jsonb(NEW) - 'user_message' - 'content')
      = (to_jsonb(OLD) - 'user_message' - 'content')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

UPDATE "chat_messages"
SET
  "user_message" = "structured_prompt",
  "content" = CASE
    WHEN "event_type" IN ('input.prompt', 'input.rejected') THEN NULL
    ELSE "content"
  END
WHERE "user_message" IS DISTINCT FROM "structured_prompt"
  OR (
    "event_type" IN ('input.prompt', 'input.rejected')
    AND "content" IS NOT NULL
  );--> statement-breakpoint

UPDATE "chat_threads"
SET "draft_user_message" = "draft_structured_prompt"
WHERE "draft_user_message" IS DISTINCT FROM "draft_structured_prompt";--> statement-breakpoint

UPDATE "zero_agent_drafts"
SET "draft_user_message" = "draft_structured_prompt"
WHERE "draft_user_message" IS DISTINCT FROM "draft_structured_prompt";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_messages"
    WHERE "user_message" IS DISTINCT FROM "structured_prompt"
      OR (
        "event_type" IN ('input.prompt', 'input.rejected')
        AND (
          "user_message" IS NULL
          OR "content" IS NOT NULL
        )
      )
  ) THEN
    RAISE EXCEPTION 'Cannot establish canonical chat userMessage storage';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_threads"
    WHERE "draft_user_message" IS DISTINCT FROM "draft_structured_prompt"
  ) OR EXISTS (
    SELECT 1
    FROM "zero_agent_drafts"
    WHERE "draft_user_message" IS DISTINCT FROM "draft_structured_prompt"
  ) THEN
    RAISE EXCEPTION 'Cannot establish canonical draft userMessage storage';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Old API versions write structured_prompt while the new API writes
-- user_message. Mirror the insert in both directions until the old API has
-- drained, and strip the retired input content projection for either writer.
CREATE FUNCTION "bridge_chat_user_message_0723"() RETURNS trigger AS $$
BEGIN
  IF NEW."user_message" IS NULL THEN
    NEW."user_message" := NEW."structured_prompt";
  ELSIF NEW."structured_prompt" IS NULL THEN
    NEW."structured_prompt" := NEW."user_message";
  ELSIF NEW."user_message" IS DISTINCT FROM NEW."structured_prompt" THEN
    RAISE EXCEPTION 'chat userMessage columns must match';
  END IF;

  IF NEW."event_type" IN ('input.prompt', 'input.rejected') THEN
    NEW."content" := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_chat_user_message_0723"
BEFORE INSERT ON "chat_messages"
FOR EACH ROW
EXECUTE FUNCTION "bridge_chat_user_message_0723"();--> statement-breakpoint

-- Drafts are mutable, so detect which side an API version changed and mirror
-- that value, including explicit clears.
CREATE FUNCTION "bridge_draft_user_message_0723"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."draft_user_message" IS NULL THEN
      NEW."draft_user_message" := NEW."draft_structured_prompt";
    ELSIF NEW."draft_structured_prompt" IS NULL THEN
      NEW."draft_structured_prompt" := NEW."draft_user_message";
    ELSIF NEW."draft_user_message"
      IS DISTINCT FROM NEW."draft_structured_prompt"
    THEN
      RAISE EXCEPTION 'draft userMessage columns must match';
    END IF;
  ELSIF NEW."draft_structured_prompt"
      IS DISTINCT FROM OLD."draft_structured_prompt"
    AND NEW."draft_user_message" IS DISTINCT FROM OLD."draft_user_message"
    AND NEW."draft_user_message"
      IS DISTINCT FROM NEW."draft_structured_prompt"
  THEN
    RAISE EXCEPTION 'draft userMessage columns must match';
  ELSIF NEW."draft_structured_prompt"
      IS DISTINCT FROM OLD."draft_structured_prompt"
  THEN
    NEW."draft_user_message" := NEW."draft_structured_prompt";
  ELSIF NEW."draft_user_message" IS DISTINCT FROM OLD."draft_user_message" THEN
    NEW."draft_structured_prompt" := NEW."draft_user_message";
  ELSIF NEW."draft_user_message"
    IS DISTINCT FROM NEW."draft_structured_prompt"
  THEN
    RAISE EXCEPTION 'draft userMessage columns must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_chat_thread_draft_user_message_0723"
BEFORE INSERT OR UPDATE ON "chat_threads"
FOR EACH ROW
EXECUTE FUNCTION "bridge_draft_user_message_0723"();--> statement-breakpoint

CREATE TRIGGER "bridge_agent_draft_user_message_0723"
BEFORE INSERT OR UPDATE ON "zero_agent_drafts"
FOR EACH ROW
EXECUTE FUNCTION "bridge_draft_user_message_0723"();
