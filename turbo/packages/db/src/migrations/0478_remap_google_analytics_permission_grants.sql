WITH permission_remaps(old_permission, source_action, new_permission) AS (
  VALUES
    ('analytics', 'allow', 'audience-exports.read'),
    ('analytics', 'allow', 'audience-exports.run'),
    ('analytics', 'allow', 'metadata.read'),
    ('analytics', 'allow', 'reports.run'),
    ('analytics', 'deny', 'audience-exports.read'),
    ('analytics', 'deny', 'audience-exports.run'),
    ('analytics', 'deny', 'metadata.read'),
    ('analytics', 'deny', 'reports.run'),
    ('analytics.edit', 'allow', 'access-reports.run'),
    ('analytics.edit', 'allow', 'accounts.delete'),
    ('analytics.edit', 'allow', 'accounts.read'),
    ('analytics.edit', 'allow', 'accounts.write'),
    ('analytics.edit', 'allow', 'change-history.read'),
    ('analytics.edit', 'allow', 'custom-definitions.read'),
    ('analytics.edit', 'allow', 'custom-definitions.write'),
    ('analytics.edit', 'allow', 'data-streams.delete'),
    ('analytics.edit', 'allow', 'data-streams.read'),
    ('analytics.edit', 'allow', 'data-streams.write'),
    ('analytics.edit', 'allow', 'key-events.delete'),
    ('analytics.edit', 'allow', 'key-events.read'),
    ('analytics.edit', 'allow', 'key-events.write'),
    ('analytics.edit', 'allow', 'links.delete'),
    ('analytics.edit', 'allow', 'links.read'),
    ('analytics.edit', 'allow', 'links.write'),
    ('analytics.edit', 'allow', 'measurement-secrets.delete'),
    ('analytics.edit', 'allow', 'measurement-secrets.read'),
    ('analytics.edit', 'allow', 'measurement-secrets.write'),
    ('analytics.edit', 'allow', 'properties.delete'),
    ('analytics.edit', 'allow', 'properties.read'),
    ('analytics.edit', 'allow', 'properties.write'),
    ('analytics.edit', 'deny', 'access-reports.run'),
    ('analytics.edit', 'deny', 'accounts.delete'),
    ('analytics.edit', 'deny', 'accounts.read'),
    ('analytics.edit', 'deny', 'accounts.write'),
    ('analytics.edit', 'deny', 'change-history.read'),
    ('analytics.edit', 'deny', 'custom-definitions.read'),
    ('analytics.edit', 'deny', 'custom-definitions.write'),
    ('analytics.edit', 'deny', 'data-streams.delete'),
    ('analytics.edit', 'deny', 'data-streams.read'),
    ('analytics.edit', 'deny', 'data-streams.write'),
    ('analytics.edit', 'deny', 'key-events.delete'),
    ('analytics.edit', 'deny', 'key-events.read'),
    ('analytics.edit', 'deny', 'key-events.write'),
    ('analytics.edit', 'deny', 'links.delete'),
    ('analytics.edit', 'deny', 'links.read'),
    ('analytics.edit', 'deny', 'links.write'),
    ('analytics.edit', 'deny', 'measurement-secrets.delete'),
    ('analytics.edit', 'deny', 'measurement-secrets.read'),
    ('analytics.edit', 'deny', 'measurement-secrets.write'),
    ('analytics.edit', 'deny', 'properties.delete'),
    ('analytics.edit', 'deny', 'properties.read'),
    ('analytics.edit', 'deny', 'properties.write'),
    ('analytics.readonly', 'allow', 'access-reports.run'),
    ('analytics.readonly', 'allow', 'accounts.read'),
    ('analytics.readonly', 'allow', 'audience-exports.read'),
    ('analytics.readonly', 'allow', 'audience-exports.run'),
    ('analytics.readonly', 'allow', 'custom-definitions.read'),
    ('analytics.readonly', 'allow', 'data-streams.read'),
    ('analytics.readonly', 'allow', 'key-events.read'),
    ('analytics.readonly', 'allow', 'links.read'),
    ('analytics.readonly', 'allow', 'measurement-secrets.read'),
    ('analytics.readonly', 'allow', 'metadata.read'),
    ('analytics.readonly', 'allow', 'properties.read'),
    ('analytics.readonly', 'allow', 'reports.run'),
    ('analytics.readonly', 'deny', 'access-reports.run'),
    ('analytics.readonly', 'deny', 'accounts.read'),
    ('analytics.readonly', 'deny', 'audience-exports.read'),
    ('analytics.readonly', 'deny', 'audience-exports.run'),
    ('analytics.readonly', 'deny', 'custom-definitions.read'),
    ('analytics.readonly', 'deny', 'data-streams.read'),
    ('analytics.readonly', 'deny', 'key-events.read'),
    ('analytics.readonly', 'deny', 'links.read'),
    ('analytics.readonly', 'deny', 'measurement-secrets.read'),
    ('analytics.readonly', 'deny', 'metadata.read'),
    ('analytics.readonly', 'deny', 'properties.read'),
    ('analytics.readonly', 'deny', 'reports.run')
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
  WHERE grant_row.connector_ref = 'google-analytics'
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
WHERE connector_ref = 'google-analytics'
  AND permission IN (
    'analytics',
    'analytics.edit',
    'analytics.readonly'
  );
