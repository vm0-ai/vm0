UPDATE "chat_teams_context" AS "context"
SET "message_files" = (
  SELECT coalesce(
    jsonb_agg(
      "file"."value" || jsonb_build_object(
        'inCurrentMessage',
        EXISTS (
          SELECT 1
          FROM "chat_events" AS "event"
          CROSS JOIN LATERAL jsonb_array_elements(
            coalesce("event"."user_message"->'parts', '[]'::jsonb)
          ) AS "part"("value")
          WHERE "event"."context_type" = 'teams'
            AND "event"."context_id" = "context"."id"
            AND "part"."value"->>'type' = 'file'
            AND "part"."value"->>'fileId' = "file"."value"->>'fileId'
        )
      )
      ORDER BY "file"."ordinality"
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("context"."message_files")
    WITH ORDINALITY AS "file"("value", "ordinality")
)
WHERE "context"."message_files" IS NOT NULL;
