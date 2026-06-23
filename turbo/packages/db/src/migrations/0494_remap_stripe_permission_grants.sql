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
  WHERE grant_row.connector_ref = 'stripe'
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
WHERE connector_ref = 'stripe'
  AND permission IN (
    'bank_account_read',
    'card_read',
    'card_write',
    'payment_source_read',
    'payment_source_write'
  );
