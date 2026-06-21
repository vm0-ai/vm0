WITH old_google_drive_permissions(permission) AS (
  VALUES
    ('drive'),
    ('drive.appdata'),
    ('drive.apps.readonly'),
    ('drive.file'),
    ('drive.install'),
    ('drive.meet.readonly'),
    ('drive.metadata'),
    ('drive.metadata.readonly'),
    ('drive.photos.readonly'),
    ('drive.readonly')
),
old_google_drive_grants AS (
  SELECT
    grants.org_id,
    grants.user_id,
    grants.agent_id,
    grants.connector_ref,
    grants.permission AS old_permission,
    grants.action,
    grants.expires_at,
    grants.created_at
  FROM user_permission_grants AS grants
  INNER JOIN old_google_drive_permissions AS old_permissions
    ON old_permissions.permission = grants.permission
  WHERE grants.connector_ref = 'google-drive'
),
new_google_drive_permissions(permission) AS (
  VALUES
    ('about.read'),
    ('apps.read'),
    ('changes.read'),
    ('channels.write'),
    ('comments.read'),
    ('comments.write'),
    ('drives.delete'),
    ('drives.read'),
    ('drives.write'),
    ('files.delete'),
    ('files.read'),
    ('files.share'),
    ('files.write'),
    ('operations.read'),
    ('replies.read'),
    ('replies.write'),
    ('revisions.delete'),
    ('revisions.read'),
    ('revisions.write')
),
mapped_google_drive_grants AS (
  SELECT
    org_id,
    user_id,
    agent_id,
    connector_ref,
    'apps.read' AS permission,
    action,
    expires_at,
    created_at
  FROM old_google_drive_grants
  WHERE old_permission = 'drive.apps.readonly'

  UNION ALL

  SELECT
    old_grants.org_id,
    old_grants.user_id,
    old_grants.agent_id,
    old_grants.connector_ref,
    new_permissions.permission,
    old_grants.action,
    old_grants.expires_at,
    old_grants.created_at
  FROM old_google_drive_grants AS old_grants
  CROSS JOIN new_google_drive_permissions AS new_permissions
  WHERE old_grants.old_permission <> 'drive.apps.readonly'
    AND old_grants.action = 'deny'
),
deduped_google_drive_grants AS (
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
      ELSE MIN(expires_at)
    END AS expires_at,
    MIN(created_at) AS created_at
  FROM mapped_google_drive_grants
  GROUP BY
    org_id,
    user_id,
    agent_id,
    connector_ref,
    permission
),
upserted_google_drive_grants AS (
  INSERT INTO user_permission_grants (
    org_id,
    user_id,
    agent_id,
    connector_ref,
    permission,
    action,
    expires_at,
    created_at,
    updated_at
  )
  SELECT
    org_id,
    user_id,
    agent_id,
    connector_ref,
    permission,
    action,
    expires_at,
    created_at,
    NOW()
  FROM deduped_google_drive_grants
  ON CONFLICT (org_id, user_id, agent_id, connector_ref, permission) DO UPDATE
  SET
    action = EXCLUDED.action,
    expires_at = EXCLUDED.expires_at,
    updated_at = NOW()
  WHERE user_permission_grants.action IS DISTINCT FROM EXCLUDED.action
     OR user_permission_grants.expires_at IS DISTINCT FROM EXCLUDED.expires_at
  RETURNING 1
)
DELETE FROM user_permission_grants AS grants
USING old_google_drive_permissions AS old_permissions
WHERE grants.connector_ref = 'google-drive'
  AND grants.permission = old_permissions.permission;
