ALTER TABLE "chat_messages" ADD COLUMN "seq_id" bigint;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "last_chat_message_seq_id" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ordered_messages AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY chat_thread_id
      ORDER BY
        created_at ASC,
        CASE
          WHEN run_lifecycle_event IS NOT NULL THEN 2147483647
          ELSE COALESCE(sequence_number, -1)
        END ASC,
        id ASC
    ) AS seq_id
  FROM chat_messages
)
UPDATE chat_messages AS message
SET seq_id = ordered_messages.seq_id
FROM ordered_messages
WHERE message.id = ordered_messages.id;--> statement-breakpoint
UPDATE chat_threads AS thread
SET last_chat_message_seq_id = COALESCE(
  (
    SELECT MAX(message.seq_id)
    FROM chat_messages AS message
    WHERE message.chat_thread_id = thread.id
  ),
  0
);--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "seq_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_thread_seq_unique" ON "chat_messages" USING btree ("chat_thread_id","seq_id");
