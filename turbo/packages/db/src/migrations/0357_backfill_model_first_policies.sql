-- Backfill model-first routes from legacy provider-first data before enabling
-- the model-first switch for staff workspaces.
--
-- Notes:
-- - Existing org_model_policies rows are preserved. The migration only inserts
--   missing model rows and only assigns a default for orgs without one.
-- - Org-scoped OAuth provider rows cannot be referenced by model-first policy:
--   OAuth policies are member-scoped by design. To keep admins working after
--   the switch is enabled, copy existing org-level OAuth credentials to every
--   cached org admin's personal model provider. Keep the org-level row intact
--   so provider-first behavior remains unchanged while the switch is off.

WITH org_oauth_providers AS (
  SELECT *
  FROM model_providers
  WHERE user_id = '__org__'
    AND type IN ('claude-code-oauth-token', 'codex-oauth-token')
),
admin_targets AS (
  SELECT DISTINCT omc.org_id, omc.user_id
  FROM org_members_cache omc
  JOIN org_oauth_providers mp ON mp.org_id = omc.org_id
  WHERE omc.role = 'admin'
),
org_oauth_secrets AS (
  SELECT
    mp.org_id,
    mp.type AS provider_type,
    s.name,
    s.encrypted_value,
    s.description,
    s.type,
    s.created_at
  FROM org_oauth_providers mp
  JOIN secrets s ON s.id = mp.secret_id
  WHERE mp.type = 'claude-code-oauth-token'

  UNION ALL

  SELECT
    mp.org_id,
    mp.type AS provider_type,
    s.name,
    s.encrypted_value,
    s.description,
    s.type,
    s.created_at
  FROM org_oauth_providers mp
  JOIN secrets s
    ON s.org_id = mp.org_id
   AND s.user_id = '__org__'
   AND s.type = 'model-provider'
   AND s.name IN (
     'CHATGPT_ACCESS_TOKEN',
     'CHATGPT_REFRESH_TOKEN',
     'CHATGPT_ACCOUNT_ID',
     'CHATGPT_ID_TOKEN'
   )
  WHERE mp.type = 'codex-oauth-token'
)
INSERT INTO secrets (
  id,
  name,
  encrypted_value,
  description,
  type,
  user_id,
  org_id,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  src.name,
  src.encrypted_value,
  src.description,
  src.type,
  admin_targets.user_id,
  src.org_id,
  NOW(),
  NOW()
FROM org_oauth_secrets src
JOIN admin_targets ON admin_targets.org_id = src.org_id
ON CONFLICT (org_id, user_id, name, type) DO NOTHING;
--> statement-breakpoint
WITH org_oauth_providers AS (
  SELECT *
  FROM model_providers
  WHERE user_id = '__org__'
    AND type IN ('claude-code-oauth-token', 'codex-oauth-token')
),
admin_targets AS (
  SELECT DISTINCT omc.org_id, omc.user_id
  FROM org_members_cache omc
  JOIN org_oauth_providers mp ON mp.org_id = omc.org_id
  WHERE omc.role = 'admin'
),
personal_oauth_providers AS (
  SELECT
    mp.org_id,
    admin_targets.user_id,
    mp.type,
    CASE
      WHEN mp.type = 'claude-code-oauth-token' THEN admin_secret.id
      ELSE NULL
    END AS secret_id,
    mp.auth_method,
    mp.selected_model,
    mp.token_expires_at,
    mp.needs_reconnect,
    mp.last_refresh_error_code,
    mp.workspace_name,
    mp.plan_type
  FROM org_oauth_providers mp
  JOIN admin_targets ON admin_targets.org_id = mp.org_id
  LEFT JOIN secrets admin_secret
    ON admin_secret.org_id = mp.org_id
   AND admin_secret.user_id = admin_targets.user_id
   AND admin_secret.type = 'model-provider'
   AND admin_secret.name = 'CLAUDE_CODE_OAUTH_TOKEN'
  WHERE (
      mp.type <> 'claude-code-oauth-token'
      OR admin_secret.id IS NOT NULL
    )
    AND (
      mp.type <> 'codex-oauth-token'
      OR NOT EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('CHATGPT_ACCESS_TOKEN'),
            ('CHATGPT_REFRESH_TOKEN'),
            ('CHATGPT_ACCOUNT_ID'),
            ('CHATGPT_ID_TOKEN')
        ) AS required_secret(name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM secrets admin_secret
          WHERE admin_secret.org_id = mp.org_id
            AND admin_secret.user_id = admin_targets.user_id
            AND admin_secret.type = 'model-provider'
            AND admin_secret.name = required_secret.name
        )
      )
    )
)
INSERT INTO model_providers (
  id,
  type,
  secret_id,
  auth_method,
  is_default,
  selected_model,
  user_id,
  org_id,
  token_expires_at,
  needs_reconnect,
  last_refresh_error_code,
  workspace_name,
  plan_type,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  type,
  secret_id,
  auth_method,
  false,
  selected_model,
  user_id,
  org_id,
  token_expires_at,
  needs_reconnect,
  last_refresh_error_code,
  workspace_name,
  plan_type,
  NOW(),
  NOW()
FROM personal_oauth_providers
ON CONFLICT (org_id, user_id, type) DO NOTHING;
--> statement-breakpoint
WITH provider_model_routes(model, provider_type, route_priority) AS (
  VALUES
    ('claude-opus-4-7', 'vm0', 60),
    ('claude-opus-4-7', 'claude-code-oauth-token', 20),
    ('claude-opus-4-7', 'anthropic-api-key', 10),
    ('claude-opus-4-7', 'openrouter-api-key', 30),
    ('claude-opus-4-6', 'vm0', 60),
    ('claude-opus-4-6', 'claude-code-oauth-token', 20),
    ('claude-opus-4-6', 'anthropic-api-key', 10),
    ('claude-opus-4-6', 'openrouter-api-key', 30),
    ('claude-opus-4-6', 'vercel-ai-gateway', 30),
    ('claude-sonnet-4-6', 'vm0', 60),
    ('claude-sonnet-4-6', 'claude-code-oauth-token', 20),
    ('claude-sonnet-4-6', 'anthropic-api-key', 10),
    ('claude-sonnet-4-6', 'openrouter-api-key', 30),
    ('claude-sonnet-4-6', 'vercel-ai-gateway', 30),
    ('claude-haiku-4-5', 'vm0', 60),
    ('claude-haiku-4-5', 'openrouter-api-key', 30),
    ('gpt-5.5', 'vm0', 60),
    ('gpt-5.5', 'openai-api-key', 10),
    ('gpt-5.5', 'codex-oauth-token', 20),
    ('gpt-5.4', 'vm0', 60),
    ('gpt-5.4', 'openai-api-key', 10),
    ('gpt-5.4', 'codex-oauth-token', 20),
    ('gpt-5.4-mini', 'vm0', 60),
    ('gpt-5.4-mini', 'openai-api-key', 10),
    ('gpt-5.4-mini', 'codex-oauth-token', 20),
    ('gpt-5.3-codex', 'vm0', 60),
    ('gpt-5.3-codex', 'openai-api-key', 10),
    ('gpt-5.3-codex', 'codex-oauth-token', 20),
    ('gpt-5.2', 'vm0', 60),
    ('gpt-5.2', 'openai-api-key', 10),
    ('gpt-5.2', 'codex-oauth-token', 20),
    ('deepseek-v4-pro', 'vm0', 60),
    ('deepseek-v4-pro', 'deepseek-api-key', 10),
    ('deepseek-v4-pro', 'openrouter-api-key', 30),
    ('deepseek-v4-flash', 'vm0', 60),
    ('deepseek-v4-flash', 'deepseek-api-key', 10),
    ('deepseek-v4-flash', 'openrouter-api-key', 30),
    ('kimi-k2.6', 'vm0', 60),
    ('kimi-k2.6', 'moonshot-api-key', 10),
    ('kimi-k2.6', 'openrouter-api-key', 30),
    ('kimi-k2.6', 'vercel-ai-gateway', 30),
    ('kimi-k2.5', 'vm0', 60),
    ('kimi-k2.5', 'moonshot-api-key', 10),
    ('kimi-k2.5', 'openrouter-api-key', 30),
    ('kimi-k2.5', 'vercel-ai-gateway', 30),
    ('MiniMax-M2.7', 'vm0', 60),
    ('MiniMax-M2.7', 'minimax-api-key', 10),
    ('MiniMax-M2.7', 'openrouter-api-key', 30),
    ('glm-5.1', 'vm0', 60),
    ('glm-5.1', 'zai-api-key', 10),
    ('glm-5.1', 'openrouter-api-key', 30)
),
provider_default_models(provider_type, model) AS (
  VALUES
    ('vm0', 'claude-sonnet-4-6'),
    ('claude-code-oauth-token', 'claude-sonnet-4-6'),
    ('anthropic-api-key', 'claude-sonnet-4-6'),
    ('openrouter-api-key', 'claude-sonnet-4-6'),
    ('vercel-ai-gateway', 'claude-sonnet-4-6'),
    ('openai-api-key', 'gpt-5.5'),
    ('codex-oauth-token', 'gpt-5.5'),
    ('moonshot-api-key', 'kimi-k2.6'),
    ('minimax-api-key', 'MiniMax-M2.7'),
    ('deepseek-api-key', 'deepseek-v4-flash'),
    ('zai-api-key', 'glm-5.1')
),
canonical_model_aliases(alias, model) AS (
  VALUES
    ('claude-opus-4.7', 'claude-opus-4-7'),
    ('claude-opus-4.6', 'claude-opus-4-6'),
    ('claude-sonnet-4.6', 'claude-sonnet-4-6'),
    ('claude-haiku-4.5', 'claude-haiku-4-5'),
    ('anthropic/claude-opus-4.7', 'claude-opus-4-7'),
    ('anthropic/claude-opus-4.6', 'claude-opus-4-6'),
    ('anthropic/claude-sonnet-4.6', 'claude-sonnet-4-6'),
    ('anthropic/claude-haiku-4.5', 'claude-haiku-4-5'),
    ('deepseek/deepseek-v4-pro', 'deepseek-v4-pro'),
    ('deepseek/deepseek-v4-flash', 'deepseek-v4-flash'),
    ('moonshotai/kimi-k2.6', 'kimi-k2.6'),
    ('moonshotai/kimi-k2.5', 'kimi-k2.5'),
    ('minimax/minimax-m2.7', 'MiniMax-M2.7'),
    ('z-ai/glm-5.1', 'glm-5.1')
),
supported_models AS (
  SELECT DISTINCT model FROM provider_model_routes
),
org_provider_routes AS (
  SELECT
    mp.org_id,
    pmr.model,
    mp.type AS default_provider_type,
    CASE
      WHEN mp.type IN ('claude-code-oauth-token', 'codex-oauth-token')
        THEN 'member'
      ELSE 'org'
    END AS credential_scope,
    CASE
      WHEN mp.type IN ('vm0', 'claude-code-oauth-token', 'codex-oauth-token')
        THEN NULL
      ELSE mp.id
    END AS model_provider_id,
    pmr.route_priority AS priority
  FROM model_providers mp
  JOIN provider_model_routes pmr ON pmr.provider_type = mp.type
  WHERE mp.user_id = '__org__'
),
default_model_routes AS (
  SELECT
    mp.org_id,
    COALESCE(alias.model, direct_model.model, pdm.model) AS model,
    mp.type AS default_provider_type,
    CASE
      WHEN mp.type IN ('claude-code-oauth-token', 'codex-oauth-token')
        THEN 'member'
      ELSE 'org'
    END AS credential_scope,
    CASE
      WHEN mp.type IN ('vm0', 'claude-code-oauth-token', 'codex-oauth-token')
        THEN NULL
      ELSE mp.id
    END AS model_provider_id,
    0 AS priority
  FROM model_providers mp
  LEFT JOIN canonical_model_aliases alias ON alias.alias = mp.selected_model
  LEFT JOIN supported_models direct_model ON direct_model.model = mp.selected_model
  LEFT JOIN provider_default_models pdm ON pdm.provider_type = mp.type
  JOIN provider_model_routes supported_route
    ON supported_route.provider_type = mp.type
   AND supported_route.model = COALESCE(alias.model, direct_model.model, pdm.model)
  WHERE mp.user_id = '__org__'
    AND mp.is_default = true
),
historical_model_sources AS (
  SELECT org_id, model_provider_id, selected_model
  FROM zero_agents
  WHERE selected_model IS NOT NULL

  UNION ALL

  SELECT org_id, model_provider_id, selected_model
  FROM zero_agent_schedules
  WHERE selected_model IS NOT NULL

  UNION ALL

  SELECT ac.org_id, ct.model_provider_id, ct.selected_model
  FROM chat_threads ct
  JOIN agent_composes ac ON ac.id = ct.agent_compose_id
  WHERE ct.selected_model IS NOT NULL
),
historical_model_routes AS (
  SELECT DISTINCT
    src.org_id,
    COALESCE(alias.model, direct_model.model) AS model,
    mp.type AS default_provider_type,
    CASE
      WHEN mp.type IN ('claude-code-oauth-token', 'codex-oauth-token')
        THEN 'member'
      ELSE 'org'
    END AS credential_scope,
    CASE
      WHEN mp.type IN ('vm0', 'claude-code-oauth-token', 'codex-oauth-token')
        THEN NULL
      ELSE mp.id
    END AS model_provider_id,
    5 AS priority
  FROM historical_model_sources src
  JOIN model_providers mp
    ON mp.id = src.model_provider_id
   AND mp.org_id = src.org_id
  LEFT JOIN canonical_model_aliases alias ON alias.alias = src.selected_model
  LEFT JOIN supported_models direct_model ON direct_model.model = src.selected_model
  JOIN provider_model_routes supported_route
    ON supported_route.provider_type = mp.type
   AND supported_route.model = COALESCE(alias.model, direct_model.model)
  WHERE (
      mp.user_id = '__org__'
      OR mp.type IN ('claude-code-oauth-token', 'codex-oauth-token')
    )
),
candidate_orgs AS (
  SELECT org_id FROM default_model_routes
  UNION
  SELECT org_id FROM historical_model_routes
  UNION
  SELECT org_id FROM org_provider_routes
),
fallback_sonnet_routes AS (
  SELECT
    candidate_orgs.org_id,
    'claude-sonnet-4-6' AS model,
    'vm0' AS default_provider_type,
    'org' AS credential_scope,
    NULL::uuid AS model_provider_id,
    70 AS priority
  FROM candidate_orgs
  WHERE NOT EXISTS (
    SELECT 1
    FROM org_model_policies existing
    WHERE existing.org_id = candidate_orgs.org_id
      AND existing.is_default = true
  )
),
all_candidates AS (
  SELECT * FROM default_model_routes
  UNION ALL
  SELECT * FROM historical_model_routes
  UNION ALL
  SELECT * FROM org_provider_routes
  UNION ALL
  SELECT * FROM fallback_sonnet_routes
),
ranked_candidates AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, model
      ORDER BY priority ASC, default_provider_type ASC, model_provider_id ASC NULLS LAST
    ) AS rank
  FROM all_candidates
  WHERE model IS NOT NULL
)
INSERT INTO org_model_policies (
  id,
  org_id,
  model,
  is_default,
  default_provider_type,
  credential_scope,
  model_provider_id,
  created_by_user_id,
  updated_by_user_id,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  org_id,
  model,
  false,
  default_provider_type,
  credential_scope,
  model_provider_id,
  NULL,
  NULL,
  NOW(),
  NOW()
FROM ranked_candidates
WHERE rank = 1
ON CONFLICT (org_id, model) DO NOTHING;
--> statement-breakpoint
WITH provider_default_models(provider_type, model) AS (
  VALUES
    ('vm0', 'claude-sonnet-4-6'),
    ('claude-code-oauth-token', 'claude-sonnet-4-6'),
    ('anthropic-api-key', 'claude-sonnet-4-6'),
    ('openrouter-api-key', 'claude-sonnet-4-6'),
    ('vercel-ai-gateway', 'claude-sonnet-4-6'),
    ('openai-api-key', 'gpt-5.5'),
    ('codex-oauth-token', 'gpt-5.5'),
    ('moonshot-api-key', 'kimi-k2.6'),
    ('minimax-api-key', 'MiniMax-M2.7'),
    ('deepseek-api-key', 'deepseek-v4-flash'),
    ('zai-api-key', 'glm-5.1')
),
canonical_model_aliases(alias, model) AS (
  VALUES
    ('claude-opus-4.7', 'claude-opus-4-7'),
    ('claude-opus-4.6', 'claude-opus-4-6'),
    ('claude-sonnet-4.6', 'claude-sonnet-4-6'),
    ('claude-haiku-4.5', 'claude-haiku-4-5'),
    ('anthropic/claude-opus-4.7', 'claude-opus-4-7'),
    ('anthropic/claude-opus-4.6', 'claude-opus-4-6'),
    ('anthropic/claude-sonnet-4.6', 'claude-sonnet-4-6'),
    ('anthropic/claude-haiku-4.5', 'claude-haiku-4-5'),
    ('deepseek/deepseek-v4-pro', 'deepseek-v4-pro'),
    ('deepseek/deepseek-v4-flash', 'deepseek-v4-flash'),
    ('moonshotai/kimi-k2.6', 'kimi-k2.6'),
    ('moonshotai/kimi-k2.5', 'kimi-k2.5'),
    ('minimax/minimax-m2.7', 'MiniMax-M2.7'),
    ('z-ai/glm-5.1', 'glm-5.1')
),
supported_models(model) AS (
  VALUES
    ('claude-opus-4-7'),
    ('claude-opus-4-6'),
    ('claude-sonnet-4-6'),
    ('claude-haiku-4-5'),
    ('deepseek-v4-pro'),
    ('deepseek-v4-flash'),
    ('kimi-k2.6'),
    ('kimi-k2.5'),
    ('MiniMax-M2.7'),
    ('glm-5.1'),
    ('gpt-5.5'),
    ('gpt-5.4'),
    ('gpt-5.4-mini'),
    ('gpt-5.3-codex'),
    ('gpt-5.2')
),
desired_defaults AS (
  SELECT
    mp.org_id,
    COALESCE(alias.model, direct_model.model, pdm.model, 'claude-sonnet-4-6') AS model
  FROM model_providers mp
  LEFT JOIN canonical_model_aliases alias ON alias.alias = mp.selected_model
  LEFT JOIN supported_models direct_model ON direct_model.model = mp.selected_model
  LEFT JOIN provider_default_models pdm ON pdm.provider_type = mp.type
  WHERE mp.user_id = '__org__'
    AND mp.is_default = true
),
orgs_without_defaults AS (
  SELECT DISTINCT p.org_id
  FROM org_model_policies p
  WHERE NOT EXISTS (
    SELECT 1
    FROM org_model_policies existing
    WHERE existing.org_id = p.org_id
      AND existing.is_default = true
  )
),
available_defaults AS (
  SELECT
    p.id,
    ROW_NUMBER() OVER (
      PARTITION BY p.org_id
      ORDER BY
        CASE
          WHEN p.model = desired.model THEN 0
          WHEN p.model = 'claude-sonnet-4-6' THEN 1
          ELSE 2
        END ASC,
        p.created_at ASC,
        p.model ASC
    ) AS rank
  FROM org_model_policies p
  JOIN orgs_without_defaults owd ON owd.org_id = p.org_id
  LEFT JOIN desired_defaults desired ON desired.org_id = p.org_id
)
UPDATE org_model_policies
SET is_default = true,
    updated_at = NOW()
FROM available_defaults
WHERE org_model_policies.id = available_defaults.id
  AND available_defaults.rank = 1;
