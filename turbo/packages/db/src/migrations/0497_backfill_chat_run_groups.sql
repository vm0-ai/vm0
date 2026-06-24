WITH run_groups AS (
  SELECT
    zr.id AS run_id,
    COALESCE(
      direct_automation.run_group_id,
      trigger_automation.run_group_id,
      zero_workflow_triggers.run_group_id
    ) AS run_group_id
  FROM zero_runs AS zr
  LEFT JOIN automations AS direct_automation
    ON direct_automation.id = zr.automation_id
  LEFT JOIN automation_triggers
    ON automation_triggers.id = zr.trigger_id
  LEFT JOIN automations AS trigger_automation
    ON trigger_automation.id = automation_triggers.automation_id
  LEFT JOIN zero_workflow_triggers
    ON zero_workflow_triggers.id = zr.workflow_trigger_id
  WHERE zr.run_group_id IS NULL
)
UPDATE zero_runs
SET run_group_id = run_groups.run_group_id
FROM run_groups
WHERE zero_runs.id = run_groups.run_id
  AND zero_runs.run_group_id IS NULL
  AND run_groups.run_group_id IS NOT NULL;

WITH message_groups AS (
  SELECT
    chat_messages.id AS message_id,
    COALESCE(
      zero_runs.run_group_id,
      automations.run_group_id
    ) AS run_group_id
  FROM chat_messages
  LEFT JOIN zero_runs
    ON zero_runs.id = chat_messages.run_id
  LEFT JOIN automations
    ON automations.id = chat_messages.automation_id
  WHERE chat_messages.run_group_id IS NULL
)
UPDATE chat_messages
SET run_group_id = message_groups.run_group_id
FROM message_groups
WHERE chat_messages.id = message_groups.message_id
  AND chat_messages.run_group_id IS NULL
  AND message_groups.run_group_id IS NOT NULL;
