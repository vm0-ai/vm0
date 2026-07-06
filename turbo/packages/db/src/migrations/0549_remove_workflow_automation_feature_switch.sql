UPDATE user_feature_switches
SET switches = switches - 'workflowAutomation',
    updated_at = NOW()
WHERE switches ? 'workflowAutomation';
