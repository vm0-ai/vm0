-- Rename the staff feature-switch JSONB key from `orgSkills` to
-- `skillsViewer`. This preserves existing per-user overrides after the
-- wire-format key rename.
UPDATE user_feature_switches
SET switches = (switches - 'orgSkills')
            || jsonb_build_object('skillsViewer', switches->'orgSkills'),
    updated_at = NOW()
WHERE switches ? 'orgSkills'
  AND NOT (switches ? 'skillsViewer');

UPDATE user_feature_switches
SET switches = switches - 'orgSkills',
    updated_at = NOW()
WHERE switches ? 'orgSkills'
  AND (switches ? 'skillsViewer');
