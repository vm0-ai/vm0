-- Block concurrent source writes while historical input events are upgraded.
LOCK TABLE "chat_messages" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- Keep append-only protection installed throughout the backfill. Only this
-- migration's structured_prompt update is allowed; every other source-field
-- mutation remains rejected.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_messages'
    AND (to_jsonb(NEW) - 'structured_prompt') = (to_jsonb(OLD) - 'structured_prompt')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Synthesize the canonical document from the legacy text and attachment
-- projection when a historical input event predates the dual-write.
UPDATE "chat_messages"
SET "structured_prompt" = jsonb_build_object(
  'version',
  1,
  'parts',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'type',
          'file',
          'fileId',
          attachment.value ->> 'id',
          'filenameSnapshot',
          attachment.value ->> 'filename',
          'contentType',
          attachment.value ->> 'contentType'
        )
        ORDER BY attachment.ordinality
      )
      FROM jsonb_array_elements(
        COALESCE("chat_messages"."attach_file_metadata", '[]'::jsonb)
      ) WITH ORDINALITY AS attachment(value, ordinality)
    ),
    '[]'::jsonb
  )
  ||
  CASE
    WHEN COALESCE("chat_messages"."content", '') <> ''
    THEN jsonb_build_array(
      jsonb_build_object(
        'type',
        'text',
        'text',
        "chat_messages"."content"
      )
    )
    ELSE '[]'::jsonb
  END
)
WHERE "event_type" IN ('input.prompt', 'input.rejected')
  AND "structured_prompt" IS NULL;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_messages"
    WHERE "event_type" IN ('input.prompt', 'input.rejected')
      AND (
        "structured_prompt" IS NULL
        OR COALESCE(
          jsonb_array_length("structured_prompt" -> 'parts'),
          0
        ) = 0
      )
  ) THEN
    RAISE EXCEPTION 'Cannot backfill userMessage for an empty historical input event';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- A persisted draft is optional, but when legacy draft content exists its
-- canonical rich document must exist too. File parts precede the text part,
-- matching createUserMessageDocument.
UPDATE "chat_threads"
SET "draft_structured_prompt" = jsonb_build_object(
  'version',
  1,
  'parts',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'type',
          'file',
          'fileId',
          attachment.value ->> 'id',
          'filenameSnapshot',
          attachment.value ->> 'filename',
          'contentType',
          attachment.value ->> 'contentType'
        )
        ORDER BY attachment.ordinality
      )
      FROM jsonb_array_elements(
        COALESCE("chat_threads"."draft_attachments", '[]'::jsonb)
      ) WITH ORDINALITY AS attachment(value, ordinality)
    ),
    '[]'::jsonb
  )
  ||
  CASE
    WHEN COALESCE("chat_threads"."draft_content", '') <> ''
    THEN jsonb_build_array(
      jsonb_build_object(
        'type',
        'text',
        'text',
        "chat_threads"."draft_content"
      )
    )
    ELSE '[]'::jsonb
  END
)
WHERE "draft_structured_prompt" IS NULL
  AND (
    COALESCE("draft_content", '') <> ''
    OR jsonb_array_length(COALESCE("draft_attachments", '[]'::jsonb)) > 0
  );--> statement-breakpoint

UPDATE "zero_agent_drafts"
SET "draft_structured_prompt" = jsonb_build_object(
  'version',
  1,
  'parts',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'type',
          'file',
          'fileId',
          attachment.value ->> 'id',
          'filenameSnapshot',
          attachment.value ->> 'filename',
          'contentType',
          attachment.value ->> 'contentType'
        )
        ORDER BY attachment.ordinality
      )
      FROM jsonb_array_elements(
        COALESCE("zero_agent_drafts"."draft_attachments", '[]'::jsonb)
      ) WITH ORDINALITY AS attachment(value, ordinality)
    ),
    '[]'::jsonb
  )
  ||
  CASE
    WHEN COALESCE("zero_agent_drafts"."draft_content", '') <> ''
    THEN jsonb_build_array(
      jsonb_build_object(
        'type',
        'text',
        'text',
        "zero_agent_drafts"."draft_content"
      )
    )
    ELSE '[]'::jsonb
  END
)
WHERE "draft_structured_prompt" IS NULL
  AND (
    COALESCE("draft_content", '') <> ''
    OR jsonb_array_length(COALESCE("draft_attachments", '[]'::jsonb)) > 0
  );--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_threads"
    WHERE "draft_structured_prompt" IS NULL
      AND (
        COALESCE("draft_content", '') <> ''
        OR COALESCE("draft_attachments", '[]'::jsonb) <> '[]'::jsonb
      )
  ) OR EXISTS (
    SELECT 1
    FROM "zero_agent_drafts"
    WHERE "draft_structured_prompt" IS NULL
      AND (
        COALESCE("draft_content", '') <> ''
        OR COALESCE("draft_attachments", '[]'::jsonb) <> '[]'::jsonb
      )
  ) THEN
    RAISE EXCEPTION 'Cannot backfill userMessage for a non-empty historical draft';
  END IF;
END;
$$;
