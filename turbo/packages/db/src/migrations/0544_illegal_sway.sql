WITH legacy_read_cursor AS (
  SELECT
    "chat_threads"."id" AS "thread_id",
    "chat_messages"."created_at" AS "read_at"
  FROM "chat_threads"
  INNER JOIN "chat_messages"
    ON "chat_messages"."id" = "chat_threads"."last_read_message_id"
  WHERE "chat_threads"."last_read_message_id" IS NOT NULL
    AND (
      "chat_threads"."last_read_at" IS NULL
      OR "chat_threads"."last_read_at" < "chat_messages"."created_at"
    )
)
UPDATE "chat_threads"
SET "last_read_at" = legacy_read_cursor."read_at"
FROM legacy_read_cursor
WHERE "chat_threads"."id" = legacy_read_cursor."thread_id";--> statement-breakpoint
DROP INDEX "idx_chat_threads_user_last_read_message";--> statement-breakpoint
CREATE INDEX "idx_chat_messages_thread_run_finish_created" ON "chat_messages" USING btree ("chat_thread_id","created_at" DESC NULLS LAST) WHERE "chat_messages"."run_lifecycle_event" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "last_read_message_id";
