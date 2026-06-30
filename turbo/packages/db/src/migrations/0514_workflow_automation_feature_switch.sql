UPDATE user_feature_switches
SET switches = (switches
    - 'workflowsViewer'
    - 'chatSlashWorkflowCommands'
    - 'workflowGmailEventTriggers'
    - 'workflowGithubLabelEventTriggers'
    - 'workflowGoogleCalendarEventTriggers'
    - 'workflowWebhookTriggers'
    - 'switchScheduleAutomationToWorkflowTrigger'
    - 'goalWorkflows'
  ) || jsonb_build_object(
    'workflowAutomation',
    CASE
      WHEN switches ? 'workflowAutomation'
        THEN (switches->>'workflowAutomation')::boolean
      ELSE
        COALESCE((switches->>'workflowsViewer')::boolean, false)
        OR COALESCE((switches->>'chatSlashWorkflowCommands')::boolean, false)
        OR COALESCE((switches->>'workflowGmailEventTriggers')::boolean, false)
        OR COALESCE((switches->>'workflowGithubLabelEventTriggers')::boolean, false)
        OR COALESCE((switches->>'workflowGoogleCalendarEventTriggers')::boolean, false)
        OR COALESCE((switches->>'workflowWebhookTriggers')::boolean, false)
        OR COALESCE((switches->>'switchScheduleAutomationToWorkflowTrigger')::boolean, false)
        OR COALESCE((switches->>'goalWorkflows')::boolean, false)
    END
  ),
  updated_at = NOW()
WHERE switches ?| ARRAY[
  'workflowsViewer',
  'chatSlashWorkflowCommands',
  'workflowGmailEventTriggers',
  'workflowGithubLabelEventTriggers',
  'workflowGoogleCalendarEventTriggers',
  'workflowWebhookTriggers',
  'switchScheduleAutomationToWorkflowTrigger',
  'goalWorkflows'
];
