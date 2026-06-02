INSERT INTO secrets (
  org_id,
  user_id,
  name,
  encrypted_value,
  description,
  type,
  created_at,
  updated_at
)
SELECT
  source.org_id,
  source.user_id,
  'LARK_APP_SECRET',
  source.encrypted_value,
  'Connector secret: LARK_APP_SECRET',
  'connector',
  source.created_at,
  source.updated_at
FROM secrets source
JOIN connectors lark_connector
  ON lark_connector.org_id = source.org_id
 AND lark_connector.user_id = source.user_id
 AND lark_connector.type = 'lark'
 AND lark_connector.auth_method = 'api-token'
WHERE source.type = 'connector'
  AND source.name = 'LARK_TOKEN'
ON CONFLICT (org_id, user_id, name, type) DO NOTHING;
