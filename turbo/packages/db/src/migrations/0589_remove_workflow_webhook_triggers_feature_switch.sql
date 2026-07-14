UPDATE user_feature_switches
SET switches = switches - 'workflowWebhookTriggers',
    updated_at = NOW()
WHERE switches ? 'workflowWebhookTriggers';
