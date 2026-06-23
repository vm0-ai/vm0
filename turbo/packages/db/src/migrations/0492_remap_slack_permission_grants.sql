WITH permission_remaps(old_permission, new_permission) AS (
  VALUES
    ('channels:history', 'conversations:history'),
    ('groups:history', 'conversations:history'),
    ('im:history', 'conversations:history'),
    ('mpim:history', 'conversations:history'),
    ('channels:read', 'conversations:read'),
    ('groups:read', 'conversations:read'),
    ('im:read', 'conversations:read'),
    ('mpim:read', 'conversations:read'),
    ('channels:manage', 'conversations:write'),
    ('channels:manage', 'conversations:write.invites'),
    ('channels:manage', 'conversations:write.topic'),
    ('channels:write', 'channels:join'),
    ('channels:write', 'conversations:write'),
    ('channels:write', 'conversations:write.invites'),
    ('channels:write', 'conversations:write.topic'),
    ('groups:write', 'conversations:write'),
    ('groups:write', 'conversations:write.invites'),
    ('groups:write', 'conversations:write.topic'),
    ('im:write', 'conversations:write'),
    ('im:write', 'conversations:write.invites'),
    ('im:write', 'conversations:write.topic'),
    ('mpim:write', 'conversations:write'),
    ('mpim:write', 'conversations:write.invites'),
    ('mpim:write', 'conversations:write.topic'),
    ('channels:write.invites', 'conversations:write.invites'),
    ('groups:write.invites', 'conversations:write.invites'),
    ('channels:write.topic', 'conversations:write.topic'),
    ('groups:write.topic', 'conversations:write.topic'),
    ('im:write.topic', 'conversations:write.topic'),
    ('mpim:write.topic', 'conversations:write.topic'),
    ('search:read.files', 'assistant.search:read'),
    ('search:read.im', 'assistant.search:read'),
    ('search:read.mpim', 'assistant.search:read'),
    ('search:read.private', 'assistant.search:read'),
    ('search:read.public', 'assistant.search:read'),
    ('search:read.users', 'assistant.search:read'),
    ('conversations.connect:manage', 'conversations.connect:read'),
    ('team:read', 'conversations.connect:read')
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
  WHERE grant_row.connector_ref = 'slack'
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
WHERE connector_ref = 'slack'
  AND permission IN (
    'channels:history',
    'channels:manage',
    'channels:read',
    'channels:write',
    'channels:write.invites',
    'channels:write.topic',
    'groups:history',
    'groups:read',
    'groups:write',
    'groups:write.invites',
    'groups:write.topic',
    'im:history',
    'im:read',
    'im:write',
    'im:write.topic',
    'mpim:history',
    'mpim:read',
    'mpim:write',
    'mpim:write.topic',
    'search:read.files',
    'search:read.im',
    'search:read.mpim',
    'search:read.private',
    'search:read.users'
  );
