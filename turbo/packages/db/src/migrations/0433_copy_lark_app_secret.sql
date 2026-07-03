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
  legacy.org_id,
  legacy.user_id,
  'LARK_APP_SECRET',
  legacy.encrypted_value,
  legacy.description,
  legacy.type,
  legacy.created_at,
  legacy.updated_at
FROM secrets legacy
WHERE legacy.type = 'connector'
  AND legacy.name = 'LARK_TOKEN'
  AND NOT EXISTS (
    SELECT 1
    FROM secrets existing
    WHERE existing.org_id = legacy.org_id
      AND existing.user_id = legacy.user_id
      AND existing.name = 'LARK_APP_SECRET'
      AND existing.type = 'connector'
  )
ON CONFLICT (org_id, user_id, name, type) DO NOTHING;
