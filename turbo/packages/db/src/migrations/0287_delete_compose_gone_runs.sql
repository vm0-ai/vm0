-- Delete agent_runs whose agent_composes row was CASCADE-deleted and left the
-- run stranded with session_id IS NULL AND agent_compose_version_id IS NULL.
--
-- Under the current schema (agent_runs.session_id should point to a live
-- agent_sessions row + CASCADE on the session -> compose chain), these rows
-- would have been removed together with the compose. They exist today because
-- the pre-#10290 schema had agent_runs.session_id nullable, and
-- agent_compose_version_id still uses SET NULL on compose deletion.
--
-- Assumes migration 0286 (backfill_session_for_failed_runs, PR #10445) has
-- already deleted the A2c-no-conversation variants, so the remaining matches
-- are exactly the A2b "compose-gone, conversation still there" bucket
-- (~633 rows as of 2026-04-21).
--
-- CASCADE on conversations.run_id automatically removes the conversation row.
-- Idempotent: a re-run matches 0 rows because the offending rows no longer
-- exist.
DELETE FROM "agent_runs"
WHERE "session_id" IS NULL
  AND "agent_compose_version_id" IS NULL;
