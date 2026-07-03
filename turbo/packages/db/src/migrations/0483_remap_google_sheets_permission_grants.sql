-- Custom SQL migration file, put your code below! --
WITH all_permissions(new_permission) AS (
  VALUES
    ('developer-metadata.read'),
    ('developer-metadata.search'),
    ('sheets.copy'),
    ('spreadsheets.create'),
    ('spreadsheets.read'),
    ('spreadsheets.read-by-data-filter'),
    ('spreadsheets.write'),
    ('values.clear'),
    ('values.read'),
    ('values.read-by-data-filter'),
    ('values.write')
),
readonly_allow_permissions(new_permission) AS (
  VALUES
    ('spreadsheets.read'),
    ('values.read')
),
readonly_deny_permissions(new_permission) AS (
  VALUES
    ('developer-metadata.read'),
    ('developer-metadata.search'),
    ('spreadsheets.read'),
    ('spreadsheets.read-by-data-filter'),
    ('values.read'),
    ('values.read-by-data-filter')
),
broad_sources(old_permission, source_action) AS (
  VALUES
    ('drive', 'allow'),
    ('drive', 'deny'),
    ('drive.file', 'allow'),
    ('drive.file', 'deny'),
    ('spreadsheets', 'allow'),
    ('spreadsheets', 'deny')
),
readonly_allow_sources(old_permission, source_action) AS (
  VALUES
    ('drive.readonly', 'allow'),
    ('spreadsheets.readonly', 'allow')
),
readonly_deny_sources(old_permission, source_action) AS (
  VALUES
    ('drive.readonly', 'deny'),
    ('spreadsheets.readonly', 'deny')
),
permission_remaps AS (
  SELECT
    broad_sources.old_permission,
    broad_sources.source_action,
    all_permissions.new_permission
  FROM broad_sources
  CROSS JOIN all_permissions
  UNION ALL
  SELECT
    readonly_allow_sources.old_permission,
    readonly_allow_sources.source_action,
    readonly_allow_permissions.new_permission
  FROM readonly_allow_sources
  CROSS JOIN readonly_allow_permissions
  UNION ALL
  SELECT
    readonly_deny_sources.old_permission,
    readonly_deny_sources.source_action,
    readonly_deny_permissions.new_permission
  FROM readonly_deny_sources
  CROSS JOIN readonly_deny_permissions
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
  WHERE grant_row.connector_ref = 'google-sheets'
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
WHERE connector_ref = 'google-sheets'
  AND permission IN (
    'drive',
    'drive.file',
    'drive.readonly',
    'spreadsheets',
    'spreadsheets.readonly'
  );
