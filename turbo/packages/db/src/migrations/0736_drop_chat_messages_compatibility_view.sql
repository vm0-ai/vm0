CREATE OR REPLACE FUNCTION "queue_artifact_catalog_file"() RETURNS trigger AS $$
DECLARE
  catalog_author_user_id text;
BEGIN
  IF NEW."url" IS NULL OR NEW."org_id" IS NULL THEN
    DELETE FROM "artifact_catalog_pending_files"
    WHERE "file_id" = NEW."id";
    RETURN NEW;
  END IF;

  catalog_author_user_id := COALESCE(
    (
      SELECT thread."user_id"
      FROM "chat_threads" AS thread
      WHERE thread."id" = COALESCE(
        NEW."chat_thread_id",
        (
          SELECT run."chat_thread_id"
          FROM "zero_runs" AS run
          WHERE run."id" = NEW."run_id"
        ),
        (
          SELECT message."chat_thread_id"
          FROM "chat_events" AS message
          WHERE message."run_id" = NEW."run_id"
          ORDER BY message."seq_id" ASC
          LIMIT 1
        )
      )
    ),
    NEW."user_id"
  );

  INSERT INTO "artifact_catalog_pending_files" (
    "file_id",
    "org_id",
    "author_user_id",
    "queued_at"
  )
  VALUES (
    NEW."id",
    NEW."org_id",
    catalog_author_user_id,
    clock_timestamp()
  )
  ON CONFLICT ("file_id") DO UPDATE SET
    "org_id" = EXCLUDED."org_id",
    "author_user_id" = EXCLUDED."author_user_id",
    "queued_at" = EXCLUDED."queued_at";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP VIEW "chat_messages";
