WITH permission_remaps(old_permission, source_action, new_permission) AS (
  VALUES
    ('gmail', 'deny', 'drafts.read'),
    ('gmail', 'deny', 'drafts.send'),
    ('gmail', 'deny', 'drafts.write'),
    ('gmail', 'deny', 'history.read'),
    ('gmail', 'deny', 'labels.read'),
    ('gmail', 'deny', 'labels.write'),
    ('gmail', 'deny', 'messages.delete'),
    ('gmail', 'deny', 'messages.read'),
    ('gmail', 'deny', 'messages.send'),
    ('gmail', 'deny', 'messages.write'),
    ('gmail', 'deny', 'notifications.write'),
    ('gmail', 'deny', 'profile.read'),
    ('gmail', 'deny', 'settings.read'),
    ('gmail', 'deny', 'threads.delete'),
    ('gmail', 'deny', 'threads.read'),
    ('gmail', 'deny', 'threads.write'),
    ('gmail.addons.current.action.compose', 'allow', 'drafts.send'),
    ('gmail.addons.current.action.compose', 'allow', 'drafts.write'),
    ('gmail.addons.current.action.compose', 'allow', 'messages.send'),
    ('gmail.addons.current.action.compose', 'deny', 'drafts.send'),
    ('gmail.addons.current.action.compose', 'deny', 'drafts.write'),
    ('gmail.addons.current.action.compose', 'deny', 'messages.send'),
    ('gmail.addons.current.message.action', 'deny', 'messages.read'),
    ('gmail.addons.current.message.action', 'deny', 'threads.read'),
    ('gmail.addons.current.message.metadata', 'deny', 'messages.read'),
    ('gmail.addons.current.message.metadata', 'deny', 'threads.read'),
    ('gmail.addons.current.message.readonly', 'deny', 'messages.read'),
    ('gmail.addons.current.message.readonly', 'deny', 'threads.read'),
    ('gmail.compose', 'allow', 'drafts.read'),
    ('gmail.compose', 'allow', 'drafts.write'),
    ('gmail.compose', 'allow', 'profile.read'),
    ('gmail.compose', 'deny', 'drafts.read'),
    ('gmail.compose', 'deny', 'drafts.write'),
    ('gmail.compose', 'deny', 'profile.read'),
    ('gmail.insert', 'deny', 'messages.write'),
    ('gmail.labels', 'allow', 'labels.read'),
    ('gmail.labels', 'allow', 'labels.write'),
    ('gmail.labels', 'deny', 'labels.read'),
    ('gmail.labels', 'deny', 'labels.write'),
    ('gmail.metadata', 'deny', 'history.read'),
    ('gmail.metadata', 'deny', 'labels.read'),
    ('gmail.metadata', 'deny', 'messages.read'),
    ('gmail.metadata', 'deny', 'notifications.write'),
    ('gmail.metadata', 'deny', 'profile.read'),
    ('gmail.metadata', 'deny', 'threads.read'),
    ('gmail.modify', 'deny', 'drafts.read'),
    ('gmail.modify', 'deny', 'drafts.send'),
    ('gmail.modify', 'deny', 'drafts.write'),
    ('gmail.modify', 'deny', 'history.read'),
    ('gmail.modify', 'deny', 'labels.read'),
    ('gmail.modify', 'deny', 'labels.write'),
    ('gmail.modify', 'deny', 'messages.read'),
    ('gmail.modify', 'deny', 'messages.send'),
    ('gmail.modify', 'deny', 'messages.write'),
    ('gmail.modify', 'deny', 'notifications.write'),
    ('gmail.modify', 'deny', 'profile.read'),
    ('gmail.modify', 'deny', 'settings.read'),
    ('gmail.modify', 'deny', 'threads.read'),
    ('gmail.modify', 'deny', 'threads.write'),
    ('gmail.readonly', 'deny', 'drafts.read'),
    ('gmail.readonly', 'deny', 'history.read'),
    ('gmail.readonly', 'deny', 'labels.read'),
    ('gmail.readonly', 'deny', 'messages.read'),
    ('gmail.readonly', 'deny', 'notifications.write'),
    ('gmail.readonly', 'deny', 'profile.read'),
    ('gmail.readonly', 'deny', 'settings.read'),
    ('gmail.readonly', 'deny', 'threads.read'),
    ('gmail.send', 'allow', 'drafts.send'),
    ('gmail.send', 'allow', 'messages.send'),
    ('gmail.send', 'deny', 'drafts.send'),
    ('gmail.send', 'deny', 'messages.send'),
    ('gmail.settings.basic', 'allow', 'settings.read'),
    ('gmail.settings.basic', 'allow', 'settings.write'),
    ('gmail.settings.basic', 'deny', 'settings.read'),
    ('gmail.settings.basic', 'deny', 'settings.write'),
    ('gmail.settings.sharing', 'allow', 'settings.sharing'),
    ('gmail.settings.sharing', 'deny', 'settings.read'),
    ('gmail.settings.sharing', 'deny', 'settings.sharing'),
    ('gmail.settings.sharing', 'deny', 'settings.write')
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
  WHERE grant_row.connector_ref = 'gmail'
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
WHERE connector_ref = 'gmail'
  AND permission IN (
    'gmail',
    'gmail.addons.current.action.compose',
    'gmail.addons.current.message.action',
    'gmail.addons.current.message.metadata',
    'gmail.addons.current.message.readonly',
    'gmail.compose',
    'gmail.insert',
    'gmail.labels',
    'gmail.metadata',
    'gmail.modify',
    'gmail.readonly',
    'gmail.send',
    'gmail.settings.basic',
    'gmail.settings.sharing'
  );
