WITH youtube_scope_permissions(new_permission) AS (
  VALUES
    ('abuse-reports.create'),
    ('activities.read'),
    ('channel-banners.upload'),
    ('channel-sections.delete'),
    ('channel-sections.read'),
    ('channel-sections.write'),
    ('channels.read'),
    ('channels.write'),
    ('i18n-languages.read'),
    ('i18n-regions.read'),
    ('live-broadcasts.control'),
    ('live-broadcasts.create'),
    ('live-broadcasts.delete'),
    ('live-broadcasts.read'),
    ('live-broadcasts.write'),
    ('live-chat-bans.write'),
    ('live-chat-messages.delete'),
    ('live-chat-messages.read'),
    ('live-chat-messages.write'),
    ('live-chat-moderators.read'),
    ('live-chat-moderators.write'),
    ('live-streams.create'),
    ('live-streams.delete'),
    ('live-streams.read'),
    ('live-streams.write'),
    ('playlist-images.delete'),
    ('playlist-images.read'),
    ('playlist-images.write'),
    ('playlist-items.delete'),
    ('playlist-items.read'),
    ('playlist-items.write'),
    ('playlists.delete'),
    ('playlists.read'),
    ('playlists.write'),
    ('search.read'),
    ('subscriptions.delete'),
    ('subscriptions.read'),
    ('subscriptions.write'),
    ('super-chat-events.read'),
    ('thumbnails.set'),
    ('video-abuse-report-reasons.read'),
    ('video-categories.read'),
    ('video-trainability.read'),
    ('videos.create'),
    ('videos.delete'),
    ('videos.rate'),
    ('videos.rating.read'),
    ('videos.read'),
    ('videos.report-abuse'),
    ('videos.write'),
    ('watermarks.delete'),
    ('watermarks.set')
),
force_ssl_permissions(new_permission) AS (
  SELECT new_permission
  FROM youtube_scope_permissions
  UNION
  SELECT new_permission
  FROM (
    VALUES
      ('captions.delete'),
      ('captions.download'),
      ('captions.read'),
      ('captions.write'),
      ('comment-threads.read'),
      ('comment-threads.write'),
      ('comments.delete'),
      ('comments.moderate'),
      ('comments.read'),
      ('comments.write')
  ) AS extra_permissions(new_permission)
),
readonly_permissions(new_permission) AS (
  VALUES
    ('activities.read'),
    ('channel-sections.read'),
    ('channels.read'),
    ('i18n-languages.read'),
    ('i18n-regions.read'),
    ('live-broadcasts.read'),
    ('live-chat-messages.read'),
    ('live-chat-moderators.read'),
    ('live-streams.read'),
    ('playlist-images.read'),
    ('playlist-items.read'),
    ('playlists.read'),
    ('search.read'),
    ('subscriptions.read'),
    ('super-chat-events.read'),
    ('tests.create'),
    ('video-abuse-report-reasons.read'),
    ('video-categories.read'),
    ('video-trainability.read'),
    ('videos.read')
),
upload_permissions(new_permission) AS (
  VALUES
    ('channel-banners.upload'),
    ('thumbnails.set'),
    ('videos.create'),
    ('watermarks.set')
),
permission_remaps AS (
  SELECT source.old_permission, source.source_action, youtube_scope_permissions.new_permission
  FROM (
    VALUES
      ('youtube', 'allow'),
      ('youtube', 'deny')
  ) AS source(old_permission, source_action)
  CROSS JOIN youtube_scope_permissions
  UNION ALL
  SELECT source.old_permission, source.source_action, force_ssl_permissions.new_permission
  FROM (
    VALUES
      ('youtube.force-ssl', 'allow'),
      ('youtube.force-ssl', 'deny')
  ) AS source(old_permission, source_action)
  CROSS JOIN force_ssl_permissions
  UNION ALL
  SELECT source.old_permission, source.source_action, readonly_permissions.new_permission
  FROM (
    VALUES
      ('youtube.readonly', 'allow'),
      ('youtube.readonly', 'deny')
  ) AS source(old_permission, source_action)
  CROSS JOIN readonly_permissions
  UNION ALL
  SELECT source.old_permission, source.source_action, upload_permissions.new_permission
  FROM (
    VALUES
      ('youtube.upload', 'allow'),
      ('youtube.upload', 'deny')
  ) AS source(old_permission, source_action)
  CROSS JOIN upload_permissions
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
  WHERE grant_row.connector_ref = 'youtube'
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
WHERE connector_ref = 'youtube'
  AND permission IN (
    'youtube',
    'youtube.force-ssl',
    'youtube.readonly',
    'youtube.upload'
  );
