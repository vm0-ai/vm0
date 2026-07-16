-- One-time cleanup of stale queued user messages (queue unification P3,
-- issue #21336). The P2 backfill imported every historical unclaimed
-- `run_id IS NULL` message as a pending queue row, including months-old
-- messages on threads that never drained. Now that the queue table is the
-- sole source of queued-user-message state, retire rows older than 7 days
-- so long-dead messages can never fire a run. The chat_messages bodies are
-- preserved as plain conversation history.
DELETE FROM "chat_message_queue"
WHERE "item_type" = 'user_message'
  AND "created_at" < now() - interval '7 days';
