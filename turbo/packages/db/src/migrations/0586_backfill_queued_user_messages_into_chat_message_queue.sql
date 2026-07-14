-- Queue unification P2 (epic #21267): backfill chat_message_queue pointer
-- rows for user messages that are currently queued under the legacy
-- convention (run_id IS NULL, unrevoked). The queue item's presence selects
-- the in-place claim style, so backfilled messages claim uniformly with
-- queue-first sends. created_at is copied from the message so FIFO order is
-- preserved. Control rows (recall/interrupt), revoked rows, and
-- insufficient-credits rows are excluded, mirroring the unclaimed predicate.
INSERT INTO "chat_message_queue" (
	"org_id", "user_id", "chat_thread_id", "item_type", "chat_message_id",
	"created_at"
)
SELECT
	ac."org_id",
	ct."user_id",
	cm."chat_thread_id",
	'user_message',
	cm."id",
	cm."created_at"
FROM "chat_messages" cm
JOIN "chat_threads" ct ON ct."id" = cm."chat_thread_id"
JOIN "agent_composes" ac ON ac."id" = ct."agent_compose_id"
WHERE cm."role" = 'user'
	AND cm."run_id" IS NULL
	AND cm."content" IS NOT NULL
	AND cm."error" IS NULL
	AND cm."revokes_message_id" IS NULL
	AND cm."interrupts_run_id" IS NULL
	AND NOT EXISTS (
		SELECT 1 FROM "chat_messages" revoker
		WHERE revoker."revokes_message_id" = cm."id"
	)
	AND NOT EXISTS (
		SELECT 1 FROM "chat_message_queue" q
		WHERE q."chat_message_id" = cm."id"
	);
