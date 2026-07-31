-- Delete the 2,786 historical CLI runs recorded from 2025-12 through
-- 2026-07-21. Deleting the parent agent_runs rows lets foreign keys cascade
-- through run-owned data. The operation is idempotent: after the matching
-- zero_runs rows have cascaded away, rerunning it deletes nothing.
--
-- The accepted impact is that rows in usage_events,
-- usage_event_hourly_rollup, org_usage_allowances, browser_sessions,
-- built_in_generation_jobs, chat_threads, and morning_briefs are retained
-- while their run_id values are set to NULL by ON DELETE SET NULL.
DELETE FROM "agent_runs" AS "agent_run"
USING "zero_runs" AS "zero_run"
WHERE "agent_run"."id" = "zero_run"."id"
  AND "zero_run"."trigger_source" = 'cli';
