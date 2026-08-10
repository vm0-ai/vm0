-- Keep the retired daily tables through this release so the outgoing API's
-- readers and writers remain legal after the migration. Drop them in a later
-- migration after the previous API release has fully drained.
DROP INDEX "idx_agent_runs_completed_org_user";
