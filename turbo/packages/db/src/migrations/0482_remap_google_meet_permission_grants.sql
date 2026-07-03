WITH route_overlap_remaps(old_permission, new_permission) AS (
  VALUES
    ('meetings.space.created', 'conference-records.read'),
    ('meetings.space.created', 'participant-sessions.read'),
    ('meetings.space.created', 'participants.read'),
    ('meetings.space.created', 'recordings.read'),
    ('meetings.space.created', 'smart-notes.read'),
    ('meetings.space.created', 'spaces.create'),
    ('meetings.space.created', 'spaces.end-active-conference'),
    ('meetings.space.created', 'spaces.read'),
    ('meetings.space.created', 'spaces.write'),
    ('meetings.space.created', 'transcript-entries.read'),
    ('meetings.space.created', 'transcripts.read'),
    ('meetings.space.readonly', 'conference-records.read'),
    ('meetings.space.readonly', 'participant-sessions.read'),
    ('meetings.space.readonly', 'participants.read'),
    ('meetings.space.readonly', 'recordings.read'),
    ('meetings.space.readonly', 'smart-notes.read'),
    ('meetings.space.readonly', 'spaces.read'),
    ('meetings.space.readonly', 'transcript-entries.read'),
    ('meetings.space.readonly', 'transcripts.read'),
    ('meetings.space.settings', 'spaces.read'),
    ('meetings.space.settings', 'spaces.write')
),
permission_remaps(old_permission, source_action, new_permission) AS (
  SELECT old_permission, 'allow', new_permission
  FROM route_overlap_remaps
  UNION ALL
  SELECT old_permission, 'deny', new_permission
  FROM route_overlap_remaps
),
migrated_grants AS (
  SELECT
    grant_row.org_id,
    grant_row.user_id,
    grant_row.agent_id,
    grant_row.connector_ref,
    permission_remaps.new_permission AS permission,
    grant_row.action,
    grant_row.expires_at
  FROM user_permission_grants AS grant_row
  INNER JOIN permission_remaps
    ON permission_remaps.old_permission = grant_row.permission
   AND permission_remaps.source_action = grant_row.action
  WHERE grant_row.connector_ref = 'google-meet'
),
folded_grants AS (
  SELECT
    org_id,
    user_id,
    agent_id,
    connector_ref,
    permission,
    CASE
      WHEN BOOL_OR(action = 'deny') THEN 'deny'
      ELSE 'allow'
    END AS action,
    CASE
      WHEN BOOL_OR(action = 'deny') THEN NULL
      WHEN BOOL_OR(expires_at IS NULL) THEN NULL
      ELSE MAX(expires_at)
    END AS expires_at
  FROM migrated_grants
  GROUP BY org_id, user_id, agent_id, connector_ref, permission
)
INSERT INTO user_permission_grants (
  org_id,
  user_id,
  agent_id,
  connector_ref,
  permission,
  action,
  expires_at
)
SELECT
  org_id,
  user_id,
  agent_id,
  connector_ref,
  permission,
  action,
  expires_at
FROM folded_grants
ON CONFLICT (org_id, user_id, agent_id, connector_ref, permission) DO UPDATE
SET
  action = CASE
    WHEN user_permission_grants.action = 'deny'
      OR EXCLUDED.action = 'deny'
      THEN 'deny'
    ELSE 'allow'
  END,
  expires_at = CASE
    WHEN user_permission_grants.action = 'deny'
      OR EXCLUDED.action = 'deny'
      THEN NULL
    WHEN user_permission_grants.expires_at IS NULL
      OR EXCLUDED.expires_at IS NULL
      THEN NULL
    ELSE GREATEST(user_permission_grants.expires_at, EXCLUDED.expires_at)
  END,
  updated_at = NOW()
WHERE user_permission_grants.action IS DISTINCT FROM CASE
    WHEN user_permission_grants.action = 'deny'
      OR EXCLUDED.action = 'deny'
      THEN 'deny'
    ELSE 'allow'
  END
  OR user_permission_grants.expires_at IS DISTINCT FROM CASE
    WHEN user_permission_grants.action = 'deny'
      OR EXCLUDED.action = 'deny'
      THEN NULL
    WHEN user_permission_grants.expires_at IS NULL
      OR EXCLUDED.expires_at IS NULL
      THEN NULL
    ELSE GREATEST(user_permission_grants.expires_at, EXCLUDED.expires_at)
  END;

DELETE FROM user_permission_grants
WHERE connector_ref = 'google-meet'
  AND permission IN (
    'meetings.space.created',
    'meetings.space.readonly',
    'meetings.space.settings'
  );
