-- Migrate admin user-level model providers to org-level and clean up all user-level data.
-- Part of #5331: after removing user-level model provider code paths,
-- orphaned user-level data must be migrated for orgs that had no org-level provider.

-- Step 1a: Migrate single-secret providers (secret_id IS NOT NULL)
-- For each org without ANY org-level provider, find the admin with the earliest
-- model_provider.created_at (via org_members_cache), then copy their providers.
WITH best_admin AS (
  SELECT DISTINCT ON (mp.org_id)
    mp.org_id,
    mp.user_id
  FROM model_providers mp
  JOIN org_members_cache omc
    ON mp.org_id = omc.org_id AND mp.user_id = omc.user_id
  WHERE omc.role = 'admin'
    AND mp.user_id != '__org__'
    AND NOT EXISTS (
      SELECT 1 FROM model_providers existing
      WHERE existing.org_id = mp.org_id AND existing.user_id = '__org__'
    )
  ORDER BY mp.org_id, mp.created_at ASC
),
new_secrets AS (
  INSERT INTO secrets (id, name, encrypted_value, description, type, user_id, org_id, created_at, updated_at)
  SELECT
    gen_random_uuid(),
    s.name,
    s.encrypted_value,
    s.description,
    s.type,
    '__org__',
    s.org_id,
    NOW(),
    NOW()
  FROM model_providers mp
  JOIN best_admin ba ON mp.org_id = ba.org_id AND mp.user_id = ba.user_id
  JOIN secrets s ON mp.secret_id = s.id
  WHERE mp.secret_id IS NOT NULL
  ON CONFLICT (org_id, user_id, name, type) DO NOTHING
  RETURNING id, org_id, name, type
)
INSERT INTO model_providers (id, type, secret_id, auth_method, is_default, selected_model, user_id, org_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  mp.type,
  ns.id,
  mp.auth_method,
  mp.is_default,
  mp.selected_model,
  '__org__',
  mp.org_id,
  NOW(),
  NOW()
FROM model_providers mp
JOIN best_admin ba ON mp.org_id = ba.org_id AND mp.user_id = ba.user_id
JOIN secrets s ON mp.secret_id = s.id
JOIN new_secrets ns ON ns.org_id = s.org_id AND ns.name = s.name AND ns.type = s.type
WHERE mp.secret_id IS NOT NULL
ON CONFLICT (org_id, user_id, type) DO NOTHING;--> statement-breakpoint

-- Step 1b+1c: Migrate multi-auth providers and their secrets in a single statement.
-- Using a single WITH block ensures best_admin is evaluated once BEFORE any inserts,
-- preventing Step 1c from seeing org-level rows created by Step 1b.
WITH best_admin AS (
  SELECT DISTINCT ON (mp.org_id)
    mp.org_id,
    mp.user_id
  FROM model_providers mp
  JOIN org_members_cache omc
    ON mp.org_id = omc.org_id AND mp.user_id = omc.user_id
  WHERE omc.role = 'admin'
    AND mp.user_id != '__org__'
    AND NOT EXISTS (
      SELECT 1 FROM model_providers existing
      WHERE existing.org_id = mp.org_id AND existing.user_id = '__org__'
    )
  ORDER BY mp.org_id, mp.created_at ASC
),
new_multi_auth_providers AS (
  INSERT INTO model_providers (id, type, secret_id, auth_method, is_default, selected_model, user_id, org_id, created_at, updated_at)
  SELECT
    gen_random_uuid(),
    mp.type,
    NULL,
    mp.auth_method,
    mp.is_default,
    mp.selected_model,
    '__org__',
    mp.org_id,
    NOW(),
    NOW()
  FROM model_providers mp
  JOIN best_admin ba ON mp.org_id = ba.org_id AND mp.user_id = ba.user_id
  WHERE mp.secret_id IS NULL AND mp.auth_method IS NOT NULL
  ON CONFLICT (org_id, user_id, type) DO NOTHING
  RETURNING org_id
)
INSERT INTO secrets (id, name, encrypted_value, description, type, user_id, org_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  s.name,
  s.encrypted_value,
  s.description,
  s.type,
  '__org__',
  s.org_id,
  NOW(),
  NOW()
FROM secrets s
JOIN best_admin ba ON s.org_id = ba.org_id AND s.user_id = ba.user_id
WHERE s.type = 'model-provider'
  AND NOT EXISTS (
    SELECT 1 FROM model_providers mp
    WHERE mp.secret_id = s.id
  )
ON CONFLICT (org_id, user_id, name, type) DO NOTHING;--> statement-breakpoint

-- Step 2a: Delete all user-level model_providers
DELETE FROM model_providers WHERE user_id != '__org__';--> statement-breakpoint

-- Step 2b: Delete all user-level model-provider secrets
DELETE FROM secrets WHERE type = 'model-provider' AND user_id != '__org__';
