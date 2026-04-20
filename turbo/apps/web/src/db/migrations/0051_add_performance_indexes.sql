-- Migration: Add performance indexes for high-frequency queries
-- Issue: #1284 - Add missing database indexes for high-frequency query columns

-- agent_runs: Composite index for user listing with time-based sorting
-- Optimizes: GET /v1/runs, user run listing queries
CREATE INDEX "idx_agent_runs_user_created" ON "agent_runs"("user_id", "created_at" DESC);

-- agent_runs: Partial index for cron cleanup job
-- Optimizes: /api/cron/cleanup-sandboxes (finds running sandboxes with stale heartbeats)
-- Only indexes rows where status='running', keeping index small
CREATE INDEX "idx_agent_runs_running_heartbeat" ON "agent_runs"("last_heartbeat_at")
  WHERE "status" = 'running';

-- agent_runs: Partial index for schedule run history
-- Optimizes: schedule-service.ts getRecentRuns query
-- Only indexes scheduled runs (schedule_id IS NOT NULL)
CREATE INDEX "idx_agent_runs_schedule_created" ON "agent_runs"("schedule_id", "created_at" DESC)
  WHERE "schedule_id" IS NOT NULL;

-- agent_sessions: Composite index for findOrCreate pattern
-- Optimizes: agent-session-service.ts findOrCreate() method
-- Covers queries with (userId, agentComposeId, artifactName) combinations
CREATE INDEX "idx_agent_sessions_user_compose_artifact"
  ON "agent_sessions"("user_id", "agent_compose_id", "artifact_name");
