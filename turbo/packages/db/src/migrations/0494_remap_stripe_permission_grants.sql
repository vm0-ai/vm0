WITH permission_remaps(old_permission, new_permission) AS (
  VALUES
    ('account_write', 'source_write'),
    ('bank_account_read', 'external_account_read'),
    ('bank_account_read', 'source_read'),
    ('bank_account_write', 'external_account_write'),
    ('bank_account_write', 'source_write'),
    ('card_read', 'external_account_read'),
    ('card_read', 'source_read'),
    ('card_write', 'external_account_write'),
    ('card_write', 'source_write'),
    ('connected_account_read', 'source_read'),
    ('payment_source_read', 'source_read'),
    ('payment_source_write', 'source_write')
),
active_deny_grants AS (
  SELECT
    grant_row.org_id,
    grant_row.user_id,
    grant_row.agent_id,
    grant_row.connector_ref,
    permission_remaps.new_permission AS permission
  FROM user_permission_grants AS grant_row
  INNER JOIN permission_remaps
    ON permission_remaps.old_permission = grant_row.permission
  WHERE grant_row.connector_ref = 'stripe'
    AND grant_row.action = 'deny'
    AND (
      grant_row.expires_at IS NULL
      OR grant_row.expires_at > NOW()
    )
),
folded_denies AS (
  SELECT
    org_id,
    user_id,
    agent_id,
    connector_ref,
    permission
  FROM active_deny_grants
  GROUP BY org_id, user_id, agent_id, connector_ref, permission
)
INSERT INTO user_permission_grants (
  org_id,
  user_id,
  agent_id,
  connector_ref,
  permission,
  action
)
SELECT
  org_id,
  user_id,
  agent_id,
  connector_ref,
  permission,
  'deny'
FROM folded_denies
ON CONFLICT (org_id, user_id, agent_id, connector_ref, permission) DO UPDATE
SET
  action = 'deny',
  expires_at = NULL,
  updated_at = NOW()
WHERE user_permission_grants.action IS DISTINCT FROM 'deny'
  OR user_permission_grants.expires_at IS NOT NULL;

DELETE FROM user_permission_grants
WHERE connector_ref = 'stripe'
  AND permission IN (
    'bank_account_read',
    'card_read',
    'card_write',
    'payment_source_read',
    'payment_source_write'
  );
