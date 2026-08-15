-- Delete the audited legacy cohort of approximately 20,227 threadless
-- agent_runs roots. This production count is an expected order of magnitude,
-- not a SQL assertion. The fixed selector requires a missing chat thread,
-- excludes test runs, uses the strict UTC cutoff 2026-08-03T05:40:26.000Z,
-- and admits only completed, failed, cancelled, or timeout runs.
--
-- Deleting agent_runs lets existing foreign keys cascade through run-owned
-- zero_runs, callbacks, queues and jobs, conversations, checkpoints, output
-- and materialization rows, admissions, uploaded-file rows, telemetry, and
-- storage lineage. The accepted cascade boundary includes the audited 113
-- stale pending callbacks, six stale built-in admissions, and 1,113 run-owned
-- uploaded-file rows; it does not add object or prefix storage deletion.
--
-- Existing SET NULL ownership preserves usage and allowance records and their
-- totals, plus independently owned generation, browser, and morning-brief
-- records. Hosted sites and deployments remain independently owned. After the
-- matching zero_runs rows cascade away, rerunning this predicate deletes
-- nothing.
DELETE FROM "agent_runs" AS "agent_run"
USING "zero_runs" AS "zero_run"
WHERE "agent_run"."id" = "zero_run"."id"
  AND "zero_run"."chat_thread_id" IS NULL
  AND "zero_run"."trigger_source" <> 'test'
  AND "agent_run"."created_at" < TIMESTAMP '2026-08-03 05:40:26.000'
  AND "agent_run"."status" IN (
    'completed',
    'failed',
    'cancelled',
    'timeout'
  );
