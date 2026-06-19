WITH named_grants AS (
  SELECT DISTINCT
    za.org_id,
    uc.user_id,
    za.id AS agent_id,
    named_connector.connector_ref,
    named_permission.permission,
    CASE named_permission.action
      WHEN 'ask' THEN 'deny'
      ELSE named_permission.action
    END AS action
  FROM zero_agents AS za
  CROSS JOIN LATERAL jsonb_each(
    CASE
      WHEN jsonb_typeof(za.permission_policies) = 'object' THEN za.permission_policies
      ELSE '{}'::jsonb
    END
  ) AS named_connector(connector_ref, permissions)
  CROSS JOIN LATERAL jsonb_each_text(
    CASE
      WHEN jsonb_typeof(named_connector.permissions) = 'object' THEN named_connector.permissions
      ELSE '{}'::jsonb
    END
  ) AS named_permission(permission, action)
  INNER JOIN user_connectors AS uc
    ON uc.org_id = za.org_id
   AND uc.agent_id = za.id
   AND uc.connector_type = named_connector.connector_ref
  WHERE named_permission.permission <> '__unknown__'
    AND named_permission.action IN ('allow', 'deny', 'ask')
),
unknown_grants AS (
  SELECT DISTINCT
    za.org_id,
    uc.user_id,
    za.id AS agent_id,
    unknown_connector.connector_ref,
    '__unknown__' AS permission,
    CASE unknown_connector.action
      WHEN 'ask' THEN 'deny'
      ELSE unknown_connector.action
    END AS action
  FROM zero_agents AS za
  CROSS JOIN LATERAL jsonb_each_text(
    CASE
      WHEN jsonb_typeof(za.unknown_permission_policies) = 'object' THEN za.unknown_permission_policies
      ELSE '{}'::jsonb
    END
  ) AS unknown_connector(connector_ref, action)
  INNER JOIN user_connectors AS uc
    ON uc.org_id = za.org_id
   AND uc.agent_id = za.id
   AND uc.connector_type = unknown_connector.connector_ref
  WHERE unknown_connector.action IN ('allow', 'deny', 'ask')
),
backfilled_grants AS (
  SELECT * FROM named_grants
  UNION ALL
  SELECT * FROM unknown_grants
),
updated_grants AS (
  UPDATE user_permission_grants AS existing
  SET
    action = backfilled.action,
    expires_at = NULL,
    updated_at = NOW()
  FROM backfilled_grants AS backfilled
  WHERE existing.org_id = backfilled.org_id
    AND existing.user_id = backfilled.user_id
    AND existing.agent_id = backfilled.agent_id
    AND existing.connector_ref = backfilled.connector_ref
    AND existing.permission = backfilled.permission
    AND (
      existing.action IS DISTINCT FROM backfilled.action
      OR existing.expires_at IS NOT NULL
    )
  RETURNING existing.org_id
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
  NULL
FROM backfilled_grants
WHERE NOT EXISTS (
  SELECT 1
  FROM user_permission_grants AS existing
  WHERE existing.org_id = backfilled_grants.org_id
    AND existing.user_id = backfilled_grants.user_id
    AND existing.agent_id = backfilled_grants.agent_id
    AND existing.connector_ref = backfilled_grants.connector_ref
    AND existing.permission = backfilled_grants.permission
);
