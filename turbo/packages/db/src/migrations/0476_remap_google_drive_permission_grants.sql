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
    ('drive.readonly'),
    ('drive.scripts')
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
old_deny_google_drive_permission_mapping(old_permission, permission) AS (
  -- Derived from the route overlap between the previous Google Drive
  -- OAuth-scope firewall and the new vm0 permission manifest.
  VALUES
    ('drive', 'about.read'),
    ('drive', 'apps.read'),
    ('drive', 'changes.read'),
    ('drive', 'channels.write'),
    ('drive', 'comments.read'),
    ('drive', 'comments.write'),
    ('drive', 'drives.delete'),
    ('drive', 'drives.read'),
    ('drive', 'drives.write'),
    ('drive', 'files.delete'),
    ('drive', 'files.read'),
    ('drive', 'files.share'),
    ('drive', 'files.write'),
    ('drive', 'operations.read'),
    ('drive', 'replies.read'),
    ('drive', 'replies.write'),
    ('drive', 'revisions.delete'),
    ('drive', 'revisions.read'),
    ('drive', 'revisions.write'),
    ('drive.appdata', 'about.read'),
    ('drive.appdata', 'apps.read'),
    ('drive.appdata', 'changes.read'),
    ('drive.appdata', 'channels.write'),
    ('drive.appdata', 'files.delete'),
    ('drive.appdata', 'files.read'),
    ('drive.appdata', 'files.share'),
    ('drive.appdata', 'files.write'),
    ('drive.appdata', 'revisions.delete'),
    ('drive.appdata', 'revisions.read'),
    ('drive.appdata', 'revisions.write'),
    ('drive.file', 'about.read'),
    ('drive.file', 'apps.read'),
    ('drive.file', 'changes.read'),
    ('drive.file', 'channels.write'),
    ('drive.file', 'comments.read'),
    ('drive.file', 'comments.write'),
    ('drive.file', 'files.delete'),
    ('drive.file', 'files.read'),
    ('drive.file', 'files.share'),
    ('drive.file', 'files.write'),
    ('drive.file', 'operations.read'),
    ('drive.file', 'replies.read'),
    ('drive.file', 'replies.write'),
    ('drive.file', 'revisions.delete'),
    ('drive.file', 'revisions.read'),
    ('drive.file', 'revisions.write'),
    ('drive.meet.readonly', 'changes.read'),
    ('drive.meet.readonly', 'channels.write'),
    ('drive.meet.readonly', 'comments.read'),
    ('drive.meet.readonly', 'files.read'),
    ('drive.meet.readonly', 'files.share'),
    ('drive.meet.readonly', 'operations.read'),
    ('drive.meet.readonly', 'replies.read'),
    ('drive.meet.readonly', 'revisions.read'),
    ('drive.metadata', 'about.read'),
    ('drive.metadata', 'apps.read'),
    ('drive.metadata', 'changes.read'),
    ('drive.metadata', 'channels.write'),
    ('drive.metadata', 'files.read'),
    ('drive.metadata', 'files.share'),
    ('drive.metadata', 'files.write'),
    ('drive.metadata', 'revisions.read'),
    ('drive.metadata.readonly', 'about.read'),
    ('drive.metadata.readonly', 'apps.read'),
    ('drive.metadata.readonly', 'changes.read'),
    ('drive.metadata.readonly', 'channels.write'),
    ('drive.metadata.readonly', 'files.read'),
    ('drive.metadata.readonly', 'files.share'),
    ('drive.metadata.readonly', 'revisions.read'),
    ('drive.photos.readonly', 'about.read'),
    ('drive.photos.readonly', 'changes.read'),
    ('drive.photos.readonly', 'channels.write'),
    ('drive.photos.readonly', 'files.read'),
    ('drive.photos.readonly', 'files.share'),
    ('drive.photos.readonly', 'files.write'),
    ('drive.photos.readonly', 'revisions.read'),
    ('drive.readonly', 'about.read'),
    ('drive.readonly', 'apps.read'),
    ('drive.readonly', 'changes.read'),
    ('drive.readonly', 'channels.write'),
    ('drive.readonly', 'comments.read'),
    ('drive.readonly', 'drives.read'),
    ('drive.readonly', 'files.read'),
    ('drive.readonly', 'files.share'),
    ('drive.readonly', 'operations.read'),
    ('drive.readonly', 'replies.read'),
    ('drive.readonly', 'revisions.read'),
    ('drive.scripts', 'files.write')
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
    mapped_permissions.permission,
    old_grants.action,
    old_grants.expires_at,
    old_grants.created_at
  FROM old_google_drive_grants AS old_grants
  INNER JOIN old_deny_google_drive_permission_mapping AS mapped_permissions
    ON mapped_permissions.old_permission = old_grants.old_permission
  WHERE old_grants.action = 'deny'
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
    action = CASE
      WHEN user_permission_grants.action = 'deny' OR EXCLUDED.action = 'deny'
        THEN 'deny'
      ELSE 'allow'
    END,
    expires_at = CASE
      WHEN user_permission_grants.action = 'deny' OR EXCLUDED.action = 'deny'
        THEN NULL
      WHEN user_permission_grants.expires_at IS NULL OR EXCLUDED.expires_at IS NULL
        THEN NULL
      ELSE GREATEST(user_permission_grants.expires_at, EXCLUDED.expires_at)
    END,
    updated_at = NOW()
  WHERE user_permission_grants.action IS DISTINCT FROM CASE
        WHEN user_permission_grants.action = 'deny' OR EXCLUDED.action = 'deny'
          THEN 'deny'
        ELSE 'allow'
      END
     OR user_permission_grants.expires_at IS DISTINCT FROM CASE
        WHEN user_permission_grants.action = 'deny' OR EXCLUDED.action = 'deny'
          THEN NULL
        WHEN user_permission_grants.expires_at IS NULL OR EXCLUDED.expires_at IS NULL
          THEN NULL
        ELSE GREATEST(user_permission_grants.expires_at, EXCLUDED.expires_at)
      END
  RETURNING 1
)
DELETE FROM user_permission_grants AS grants
USING old_google_drive_permissions AS old_permissions
WHERE grants.connector_ref = 'google-drive'
  AND grants.permission = old_permissions.permission;
