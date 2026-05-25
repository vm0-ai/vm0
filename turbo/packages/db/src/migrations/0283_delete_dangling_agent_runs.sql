-- Delete agent_runs whose session_id points to a deleted agent_sessions row.
--
-- Background: when an agent (or its owning user/org) is deleted, the current
-- delete paths (deleteComposeById, deleteUserData, deleteOrgData) explicitly
-- delete matching agent_runs before dropping agent_composes. Historically this
-- cleanup was missing, leaving 310 orphan rows with session_id pointing to
-- agent_sessions rows that were cascade-deleted when the agent was removed.
--
-- Effect: CASCADE also removes the linked checkpoints, conversations,
-- agent_run_callbacks, sandbox_telemetry, and zero_runs rows. Billing
-- records (credit_usage, client_credit_usage, connector_billing,
-- chat_messages) survive via SET NULL per existing FK policy.
--
-- Idempotent: a re-run matches 0 rows because the offending rows no longer
-- exist.
DELETE FROM "agent_runs"
WHERE "session_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "agent_sessions" s
    WHERE s.id = "agent_runs"."session_id"
  );
