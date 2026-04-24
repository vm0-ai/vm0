-- Backfill the new read marker so existing threads do not all become unread
-- when `is_read` switches from the legacy last_read_at timestamp watermark to
-- the latest-read message id.
--
-- Threads with no messages remain NULL; the list query treats those as read.

DO $$
DECLARE
  affected BIGINT;
BEGIN
  SELECT COUNT(*) INTO affected
  FROM chat_threads t
  WHERE t.last_read_message_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM chat_messages m
      WHERE m.chat_thread_id = t.id
    );

  RAISE NOTICE 'migration 0313: backfilling last_read_message_id for % chat_threads rows', affected;
END $$;--> statement-breakpoint

WITH latest_message AS (
  SELECT DISTINCT ON (m.chat_thread_id)
    m.chat_thread_id,
    m.id
  FROM chat_messages m
  ORDER BY m.chat_thread_id, m.created_at DESC, m.id DESC
)
UPDATE chat_threads AS t
SET last_read_message_id = latest_message.id
FROM latest_message
WHERE latest_message.chat_thread_id = t.id
  AND t.last_read_message_id IS NULL;
