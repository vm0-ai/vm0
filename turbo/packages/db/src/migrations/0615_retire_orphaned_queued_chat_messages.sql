-- Queue unification P3 removed stale queue pointers while intentionally
-- preserving their user-message rows (migration 0608). Those rows still look
-- queued to append-only clients because they have no run_id, queue item, or
-- revoker. Retire the audited historical set by appending the same null-content
-- recall control row used by the live recall path.
--
-- The fixed cutoff is one day after the newest matching production row found
-- during the 2026-07-17 masked-data audit. Keeping the cutoff fixed prevents a
-- future migration retry from retiring newer messages. The inserted rows use
-- their default current created_at so clients with a persisted sinceId cursor
-- receive the control row and fold away the stale pending message.
INSERT INTO "chat_messages" (
	"chat_thread_id",
	"role",
	"content",
	"run_id",
	"revokes_message_id"
)
SELECT
	message."chat_thread_id",
	'user',
	NULL,
	NULL,
	message."id"
FROM "chat_messages" message
WHERE message."role" = 'user'
	AND message."run_id" IS NULL
	AND message."content" IS NOT NULL
	AND message."error" IS NULL
	AND message."revokes_message_id" IS NULL
	AND message."interrupts_run_id" IS NULL
	AND message."run_event_id" IS NULL
	AND message."run_lifecycle_event" IS NULL
	AND message."usage_payload" IS NULL
	AND message."created_at" < TIMESTAMP '2026-07-03 00:00:00'
	AND NOT EXISTS (
		SELECT 1
		FROM "chat_message_queue" queue_item
		WHERE queue_item."item_type" = 'user_message'
			AND queue_item."chat_message_id" = message."id"
	)
	AND NOT EXISTS (
		SELECT 1
		FROM "chat_messages" revoker
		WHERE revoker."revokes_message_id" = message."id"
	)
ON CONFLICT ("revokes_message_id") DO NOTHING;
