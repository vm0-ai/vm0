-- Update slack_thread_sessions unique index to include binding_id
-- This allows different agents to have separate sessions in the same thread

-- Drop the old index
DROP INDEX IF EXISTS "idx_slack_thread_sessions_thread";

-- Create new unique index including binding_id
CREATE UNIQUE INDEX "idx_slack_thread_sessions_thread_binding"
  ON "slack_thread_sessions"("slack_binding_id", "slack_channel_id", "slack_thread_ts");
