-- Rename user-facing workflow feature-switch override keys from skill
-- terminology to workflow terminology. Existing target keys take precedence
-- when both old and new keys are present.
UPDATE user_feature_switches
SET switches = (switches - 'skillsViewer' - 'chatSlashSkillCommands')
            || CASE
                 WHEN switches ? 'skillsViewer'
                   AND NOT (switches ? 'workflowsViewer')
                 THEN jsonb_build_object('workflowsViewer', switches->'skillsViewer')
                 ELSE '{}'::jsonb
               END
            || CASE
                 WHEN switches ? 'chatSlashSkillCommands'
                   AND NOT (switches ? 'chatSlashWorkflowCommands')
                 THEN jsonb_build_object('chatSlashWorkflowCommands', switches->'chatSlashSkillCommands')
                 ELSE '{}'::jsonb
               END,
    updated_at = NOW()
WHERE switches ? 'skillsViewer'
   OR switches ? 'chatSlashSkillCommands';
