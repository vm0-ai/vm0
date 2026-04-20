-- Backfill vm0 managed model provider for all orgs that don't already have one.
-- For orgs without any org-level model provider, the new vm0 provider is set as default.

INSERT INTO model_providers (id, type, secret_id, auth_method, is_default, selected_model, user_id, org_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  'vm0',
  NULL,
  NULL,
  NOT EXISTS (
    SELECT 1 FROM model_providers existing
    WHERE existing.org_id = oc.org_id
      AND existing.user_id = '__org__'
      AND existing.is_default = true
  ),
  'claude-sonnet-4.6',
  '__org__',
  oc.org_id,
  NOW(),
  NOW()
FROM org_cache oc
WHERE NOT EXISTS (
  SELECT 1 FROM model_providers mp
  WHERE mp.org_id = oc.org_id
    AND mp.user_id = '__org__'
    AND mp.type = 'vm0'
)
ON CONFLICT (org_id, user_id, type) DO NOTHING;
