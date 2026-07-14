-- One-time cutover for the chat message queue (epic #21267, P1).
--
-- 1. Atomically move pending workflow queue events into chat_message_queue,
--    preserving id and created_at so FIFO order and dedup survive. DELETE ...
--    RETURNING locks the rows, so an old API instance claiming concurrently
--    either wins the row (it never reaches the new table) or blocks.
-- 2. Copy pause state onto chat_threads. Legacy pause columns keep being
--    dual-written until the dual-read is removed.
--
-- Old API versions may still insert into zero_workflow_queue_events during
-- the rolling deploy; the new drain reads that table first until it is empty.
WITH moved AS (
	DELETE FROM "zero_workflow_queue_events" RETURNING *
)
INSERT INTO "chat_message_queue" (
	"id", "org_id", "user_id", "chat_thread_id", "item_type",
	"trigger_id", "trigger_source", "trigger_brief", "encrypted_params",
	"created_at"
)
SELECT
	"id", "org_id", "user_id", "chat_thread_id", 'workflow_event',
	"trigger_id", "trigger_source", "trigger_brief", "encrypted_params",
	"created_at"
FROM moved
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "chat_threads" ct
SET
	"queue_paused_at" = w."queue_paused_at",
	"pause_reason" = w."pause_reason"
FROM "workflow_user_trigger_threads" w
WHERE w."chat_thread_id" = ct."id"
	AND w."queue_paused_at" IS NOT NULL;
