-- Safety-net backfill 1: legacy first-run rows whose session was created by the
-- webhook fallback (checkpoint-service.ts Branch C). conversations.run_id points
-- back to the run, and agent_sessions.conversation_id points back to the
-- conversation.
UPDATE "agent_runs" r
SET session_id = s.id
FROM "conversations" c, "agent_sessions" s
WHERE r.session_id IS NULL
  AND c.run_id = r.id
  AND s.conversation_id = c.id;
--> statement-breakpoint
-- Safety-net backfill 2: legacy continuation rows where only
-- continued_from_session_id was set.
UPDATE "agent_runs"
SET session_id = continued_from_session_id
WHERE session_id IS NULL
  AND continued_from_session_id IS NOT NULL;
