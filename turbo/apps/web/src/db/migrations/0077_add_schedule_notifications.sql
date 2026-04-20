-- Make slack_binding_id nullable on slack_thread_sessions
ALTER TABLE "slack_thread_sessions" ALTER COLUMN "slack_binding_id" DROP NOT NULL;

-- Partial unique index for notification-initiated sessions (NULL binding)
CREATE UNIQUE INDEX "idx_slack_thread_sessions_thread_no_binding"
  ON "slack_thread_sessions" ("slack_channel_id", "slack_thread_ts")
  WHERE "slack_binding_id" IS NULL;
