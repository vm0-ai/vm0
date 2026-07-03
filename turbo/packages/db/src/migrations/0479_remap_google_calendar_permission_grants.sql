WITH permission_remaps(old_permission, source_action, new_permission) AS (
  VALUES
    ('calendar.acls', 'allow', 'acl.delete'),
    ('calendar.acls', 'allow', 'acl.read'),
    ('calendar.acls', 'allow', 'acl.write'),
    ('calendar.acls.readonly', 'allow', 'acl.read'),
    ('calendar.calendarlist', 'allow', 'calendar-list.delete'),
    ('calendar.calendarlist', 'allow', 'calendar-list.read'),
    ('calendar.calendarlist', 'allow', 'calendar-list.write'),
    ('calendar.calendarlist', 'allow', 'colors.read'),
    ('calendar.calendarlist.readonly', 'allow', 'calendar-list.read'),
    ('calendar.calendarlist.readonly', 'allow', 'colors.read'),
    ('calendar.calendars', 'allow', 'calendars.clear'),
    ('calendar.calendars', 'allow', 'calendars.delete'),
    ('calendar.calendars', 'allow', 'calendars.read'),
    ('calendar.calendars', 'allow', 'calendars.write'),
    ('calendar.calendars.readonly', 'allow', 'calendars.read'),
    ('calendar.events', 'allow', 'events.delete'),
    ('calendar.events', 'allow', 'events.read'),
    ('calendar.events', 'allow', 'events.write'),
    ('calendar.events.freebusy', 'allow', 'colors.read'),
    ('calendar.events.freebusy', 'allow', 'freebusy.query'),
    ('calendar.events.readonly', 'allow', 'events.read'),
    ('calendar.freebusy', 'allow', 'freebusy.query'),
    ('calendar.readonly', 'allow', 'calendar-list.read'),
    ('calendar.readonly', 'allow', 'calendars.read'),
    ('calendar.readonly', 'allow', 'colors.read'),
    ('calendar.readonly', 'allow', 'events.read'),
    ('calendar.readonly', 'allow', 'freebusy.query'),
    ('calendar.readonly', 'allow', 'settings.read'),
    ('calendar.settings.readonly', 'allow', 'settings.read'),
    ('calendar', 'deny', 'acl.delete'),
    ('calendar', 'deny', 'acl.read'),
    ('calendar', 'deny', 'acl.write'),
    ('calendar', 'deny', 'calendar-list.delete'),
    ('calendar', 'deny', 'calendar-list.read'),
    ('calendar', 'deny', 'calendar-list.write'),
    ('calendar', 'deny', 'calendars.clear'),
    ('calendar', 'deny', 'calendars.delete'),
    ('calendar', 'deny', 'calendars.read'),
    ('calendar', 'deny', 'calendars.write'),
    ('calendar', 'deny', 'colors.read'),
    ('calendar', 'deny', 'events.delete'),
    ('calendar', 'deny', 'events.read'),
    ('calendar', 'deny', 'events.write'),
    ('calendar', 'deny', 'freebusy.query'),
    ('calendar', 'deny', 'notifications.write'),
    ('calendar', 'deny', 'settings.read'),
    ('calendar.acls', 'deny', 'acl.delete'),
    ('calendar.acls', 'deny', 'acl.read'),
    ('calendar.acls', 'deny', 'acl.write'),
    ('calendar.acls', 'deny', 'notifications.write'),
    ('calendar.acls.readonly', 'deny', 'acl.read'),
    ('calendar.acls.readonly', 'deny', 'notifications.write'),
    ('calendar.app.created', 'deny', 'calendar-list.delete'),
    ('calendar.app.created', 'deny', 'calendar-list.read'),
    ('calendar.app.created', 'deny', 'calendar-list.write'),
    ('calendar.app.created', 'deny', 'calendars.delete'),
    ('calendar.app.created', 'deny', 'calendars.read'),
    ('calendar.app.created', 'deny', 'calendars.write'),
    ('calendar.app.created', 'deny', 'colors.read'),
    ('calendar.app.created', 'deny', 'events.delete'),
    ('calendar.app.created', 'deny', 'events.read'),
    ('calendar.app.created', 'deny', 'events.write'),
    ('calendar.app.created', 'deny', 'notifications.write'),
    ('calendar.calendarlist', 'deny', 'calendar-list.delete'),
    ('calendar.calendarlist', 'deny', 'calendar-list.read'),
    ('calendar.calendarlist', 'deny', 'calendar-list.write'),
    ('calendar.calendarlist', 'deny', 'colors.read'),
    ('calendar.calendarlist', 'deny', 'notifications.write'),
    ('calendar.calendarlist.readonly', 'deny', 'calendar-list.read'),
    ('calendar.calendarlist.readonly', 'deny', 'colors.read'),
    ('calendar.calendarlist.readonly', 'deny', 'notifications.write'),
    ('calendar.calendars', 'deny', 'calendars.clear'),
    ('calendar.calendars', 'deny', 'calendars.delete'),
    ('calendar.calendars', 'deny', 'calendars.read'),
    ('calendar.calendars', 'deny', 'calendars.write'),
    ('calendar.calendars.readonly', 'deny', 'calendars.read'),
    ('calendar.events', 'deny', 'events.delete'),
    ('calendar.events', 'deny', 'events.read'),
    ('calendar.events', 'deny', 'events.write'),
    ('calendar.events', 'deny', 'notifications.write'),
    ('calendar.events.freebusy', 'deny', 'colors.read'),
    ('calendar.events.freebusy', 'deny', 'events.read'),
    ('calendar.events.freebusy', 'deny', 'freebusy.query'),
    ('calendar.events.freebusy', 'deny', 'notifications.write'),
    ('calendar.events.owned', 'deny', 'colors.read'),
    ('calendar.events.owned', 'deny', 'events.delete'),
    ('calendar.events.owned', 'deny', 'events.read'),
    ('calendar.events.owned', 'deny', 'events.write'),
    ('calendar.events.owned', 'deny', 'notifications.write'),
    ('calendar.events.owned.readonly', 'deny', 'colors.read'),
    ('calendar.events.owned.readonly', 'deny', 'events.read'),
    ('calendar.events.owned.readonly', 'deny', 'notifications.write'),
    ('calendar.events.public.readonly', 'deny', 'colors.read'),
    ('calendar.events.public.readonly', 'deny', 'events.read'),
    ('calendar.events.public.readonly', 'deny', 'notifications.write'),
    ('calendar.events.readonly', 'deny', 'events.read'),
    ('calendar.events.readonly', 'deny', 'notifications.write'),
    ('calendar.freebusy', 'deny', 'freebusy.query'),
    ('calendar.readonly', 'deny', 'acl.read'),
    ('calendar.readonly', 'deny', 'calendar-list.read'),
    ('calendar.readonly', 'deny', 'calendars.read'),
    ('calendar.readonly', 'deny', 'colors.read'),
    ('calendar.readonly', 'deny', 'events.read'),
    ('calendar.readonly', 'deny', 'freebusy.query'),
    ('calendar.readonly', 'deny', 'notifications.write'),
    ('calendar.readonly', 'deny', 'settings.read'),
    ('calendar.settings.readonly', 'deny', 'notifications.write'),
    ('calendar.settings.readonly', 'deny', 'settings.read')
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
  WHERE grant_row.connector_ref = 'google-calendar'
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
WHERE connector_ref = 'google-calendar'
  AND permission IN (
    'calendar',
    'calendar.acls',
    'calendar.acls.readonly',
    'calendar.app.created',
    'calendar.calendarlist',
    'calendar.calendarlist.readonly',
    'calendar.calendars',
    'calendar.calendars.readonly',
    'calendar.events',
    'calendar.events.freebusy',
    'calendar.events.owned',
    'calendar.events.owned.readonly',
    'calendar.events.public.readonly',
    'calendar.events.readonly',
    'calendar.freebusy',
    'calendar.readonly',
    'calendar.settings.readonly'
  );
