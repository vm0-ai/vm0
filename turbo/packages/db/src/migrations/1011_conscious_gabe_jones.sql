-- vm0:non-transactional

-- Interrupted concurrent builds leave an invalid relation behind. Drop the
-- generated name first so a full migration retry always rebuilds it safely.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_output_tool_thread_seq_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_events_output_tool_thread_seq_idx"
ON "chat_events" USING btree ("chat_thread_id", "seq_id")
WHERE "chat_events"."event_type" = 'output.tool';
