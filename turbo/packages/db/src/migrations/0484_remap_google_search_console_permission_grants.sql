-- Custom SQL migration file, put your code below! --
WITH permission_remaps(old_permission, source_action, new_permission) AS (
  VALUES
    ('webmasters', 'allow', 'search-analytics.query'),
    ('webmasters', 'allow', 'sitemaps.delete'),
    ('webmasters', 'allow', 'sitemaps.read'),
    ('webmasters', 'allow', 'sitemaps.write'),
    ('webmasters', 'allow', 'sites.delete'),
    ('webmasters', 'allow', 'sites.read'),
    ('webmasters', 'allow', 'sites.write'),
    ('webmasters', 'allow', 'url-inspection.inspect'),
    ('webmasters.readonly', 'allow', 'search-analytics.query'),
    ('webmasters.readonly', 'allow', 'sitemaps.read'),
    ('webmasters.readonly', 'allow', 'sites.read'),
    ('webmasters.readonly', 'allow', 'url-inspection.inspect'),
    ('webmasters', 'deny', 'mobile-friendly-tests.run'),
    ('webmasters', 'deny', 'search-analytics.query'),
    ('webmasters', 'deny', 'sitemaps.delete'),
    ('webmasters', 'deny', 'sitemaps.read'),
    ('webmasters', 'deny', 'sitemaps.write'),
    ('webmasters', 'deny', 'sites.delete'),
    ('webmasters', 'deny', 'sites.read'),
    ('webmasters', 'deny', 'sites.write'),
    ('webmasters', 'deny', 'url-inspection.inspect'),
    ('__unknown__', 'deny', 'mobile-friendly-tests.run'),
    ('webmasters.readonly', 'deny', 'mobile-friendly-tests.run'),
    ('webmasters.readonly', 'deny', 'search-analytics.query'),
    ('webmasters.readonly', 'deny', 'sitemaps.read'),
    ('webmasters.readonly', 'deny', 'sites.read'),
    ('webmasters.readonly', 'deny', 'url-inspection.inspect')
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
  WHERE grant_row.connector_ref = 'google-search-console'
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
WHERE connector_ref = 'google-search-console'
  AND permission IN (
    'webmasters',
    'webmasters.readonly'
  );
