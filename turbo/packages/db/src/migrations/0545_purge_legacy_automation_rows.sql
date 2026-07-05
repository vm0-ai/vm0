-- The schedule/workflow migration moved active scheduling to
-- zero_workflow_triggers. The legacy automation rows are no longer served by
-- UI/API; deleting automations cascades automation_triggers and clears
-- zero_runs.automation_id / zero_runs.trigger_id through existing FK rules.
DELETE FROM "automations";
