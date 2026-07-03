DROP TABLE IF EXISTS pg_temp.vm0_remove_poor_agent_model_policies;
--> statement-breakpoint
CREATE TEMP TABLE vm0_remove_poor_agent_model_policies (
    id uuid PRIMARY KEY,
    org_id text NOT NULL,
    deprecated_model varchar(255) NOT NULL,
    replacement_model varchar(255) NOT NULL,
    was_default boolean NOT NULL,
    replacement_default_provider_type varchar(50) NOT NULL,
    replacement_credential_scope varchar(20) NOT NULL,
    replacement_model_provider_id uuid
);
--> statement-breakpoint
INSERT INTO vm0_remove_poor_agent_model_policies (
    id,
    org_id,
    deprecated_model,
    replacement_model,
    was_default,
    replacement_default_provider_type,
    replacement_credential_scope,
    replacement_model_provider_id
)
SELECT
    id,
    org_id,
    model AS deprecated_model,
    CASE
        WHEN model = 'claude-haiku-4-5' THEN 'claude-sonnet-4-6'
        WHEN model = 'deepseek-v4-flash' THEN 'deepseek-v4-pro'
        WHEN model = 'MiniMax-M2.7' AND default_provider_type = 'openrouter-api-key' THEN 'claude-sonnet-4-6'
        WHEN model = 'MiniMax-M2.7' THEN 'MiniMax-M3'
    END AS replacement_model,
    is_default AS was_default,
    default_provider_type AS replacement_default_provider_type,
    credential_scope AS replacement_credential_scope,
    model_provider_id AS replacement_model_provider_id
FROM org_model_policies
WHERE model IN ('claude-haiku-4-5', 'deepseek-v4-flash', 'MiniMax-M2.7');
--> statement-breakpoint
UPDATE org_model_policies AS deprecated
SET
    is_default = false,
    updated_at = NOW()
FROM vm0_remove_poor_agent_model_policies AS policy
WHERE deprecated.id = policy.id
  AND policy.was_default = true
  AND EXISTS (
      SELECT 1
      FROM org_model_policies AS replacement
      WHERE replacement.org_id = policy.org_id
        AND replacement.model = policy.replacement_model
        AND replacement.id <> policy.id
  );
--> statement-breakpoint
UPDATE org_model_policies AS replacement
SET
    is_default = true,
    default_provider_type = policy.replacement_default_provider_type,
    credential_scope = policy.replacement_credential_scope,
    model_provider_id = policy.replacement_model_provider_id,
    updated_at = NOW()
FROM vm0_remove_poor_agent_model_policies AS policy
WHERE policy.was_default = true
  AND replacement.org_id = policy.org_id
  AND replacement.model = policy.replacement_model
  AND replacement.id <> policy.id;
--> statement-breakpoint
DELETE FROM org_model_policies AS deprecated
USING vm0_remove_poor_agent_model_policies AS policy
WHERE deprecated.id = policy.id
  AND EXISTS (
      SELECT 1
      FROM org_model_policies AS replacement
      WHERE replacement.org_id = policy.org_id
        AND replacement.model = policy.replacement_model
        AND replacement.id <> policy.id
  );
--> statement-breakpoint
DELETE FROM org_model_policies AS duplicate
USING vm0_remove_poor_agent_model_policies AS policy
WHERE duplicate.id = policy.id
  AND duplicate.id NOT IN (
      SELECT DISTINCT ON (remaining_policy.org_id, remaining_policy.replacement_model)
          remaining_policy.id
      FROM vm0_remove_poor_agent_model_policies AS remaining_policy
      WHERE EXISTS (
          SELECT 1
          FROM org_model_policies AS remaining_row
          WHERE remaining_row.id = remaining_policy.id
      )
      ORDER BY
          remaining_policy.org_id,
          remaining_policy.replacement_model,
          remaining_policy.was_default DESC,
          remaining_policy.id
  );
--> statement-breakpoint
UPDATE org_model_policies AS policy
SET
    model = replacement.replacement_model,
    default_provider_type = replacement.replacement_default_provider_type,
    credential_scope = replacement.replacement_credential_scope,
    model_provider_id = replacement.replacement_model_provider_id,
    updated_at = NOW()
FROM vm0_remove_poor_agent_model_policies AS replacement
WHERE policy.id = replacement.id;
--> statement-breakpoint
UPDATE model_providers
SET
    selected_model = CASE selected_model
        WHEN 'claude-haiku-4-5' THEN
            CASE
                WHEN type IN ('openrouter-api-key', 'vercel-ai-gateway') THEN 'anthropic/claude-sonnet-4.6'
                ELSE 'claude-sonnet-4-6'
            END
        WHEN 'claude-haiku-4.5' THEN
            CASE
                WHEN type IN ('openrouter-api-key', 'vercel-ai-gateway') THEN 'anthropic/claude-sonnet-4.6'
                ELSE 'claude-sonnet-4-6'
            END
        WHEN 'anthropic/claude-haiku-4.5' THEN
            CASE
                WHEN type IN ('openrouter-api-key', 'vercel-ai-gateway') THEN 'anthropic/claude-sonnet-4.6'
                ELSE 'claude-sonnet-4-6'
            END
        WHEN 'deepseek-v4-flash' THEN
            CASE
                WHEN type = 'openrouter-api-key' THEN 'deepseek/deepseek-v4-pro'
                ELSE 'deepseek-v4-pro'
            END
        WHEN 'deepseek/deepseek-v4-flash' THEN
            CASE
                WHEN type = 'openrouter-api-key' THEN 'deepseek/deepseek-v4-pro'
                ELSE 'deepseek-v4-pro'
            END
        WHEN 'MiniMax-M2.7' THEN
            CASE
                WHEN type IN ('openrouter-api-key', 'vercel-ai-gateway') THEN 'anthropic/claude-sonnet-4.6'
                ELSE 'MiniMax-M3'
            END
        WHEN 'minimax/minimax-m2.7' THEN
            CASE
                WHEN type IN ('openrouter-api-key', 'vercel-ai-gateway') THEN 'anthropic/claude-sonnet-4.6'
                ELSE 'MiniMax-M3'
            END
    END,
    updated_at = NOW()
WHERE selected_model IN (
    'claude-haiku-4-5',
    'claude-haiku-4.5',
    'anthropic/claude-haiku-4.5',
    'deepseek-v4-flash',
    'deepseek/deepseek-v4-flash',
    'MiniMax-M2.7',
    'minimax/minimax-m2.7'
);
--> statement-breakpoint
UPDATE zero_agents
SET
    selected_model = CASE selected_model
        WHEN 'claude-haiku-4-5' THEN 'claude-sonnet-4-6'
        WHEN 'claude-haiku-4.5' THEN 'claude-sonnet-4-6'
        WHEN 'anthropic/claude-haiku-4.5' THEN 'claude-sonnet-4-6'
        WHEN 'deepseek-v4-flash' THEN 'deepseek-v4-pro'
        WHEN 'deepseek/deepseek-v4-flash' THEN 'deepseek-v4-pro'
        WHEN 'MiniMax-M2.7' THEN 'MiniMax-M3'
        WHEN 'minimax/minimax-m2.7' THEN 'MiniMax-M3'
    END,
    updated_at = NOW()
WHERE selected_model IN (
    'claude-haiku-4-5',
    'claude-haiku-4.5',
    'anthropic/claude-haiku-4.5',
    'deepseek-v4-flash',
    'deepseek/deepseek-v4-flash',
    'MiniMax-M2.7',
    'minimax/minimax-m2.7'
);
--> statement-breakpoint
UPDATE chat_threads
SET
    selected_model = CASE selected_model
        WHEN 'claude-haiku-4-5' THEN 'claude-sonnet-4-6'
        WHEN 'claude-haiku-4.5' THEN 'claude-sonnet-4-6'
        WHEN 'anthropic/claude-haiku-4.5' THEN 'claude-sonnet-4-6'
        WHEN 'deepseek-v4-flash' THEN 'deepseek-v4-pro'
        WHEN 'deepseek/deepseek-v4-flash' THEN 'deepseek-v4-pro'
        WHEN 'MiniMax-M2.7' THEN 'MiniMax-M3'
        WHEN 'minimax/minimax-m2.7' THEN 'MiniMax-M3'
    END,
    updated_at = NOW()
WHERE selected_model IN (
    'claude-haiku-4-5',
    'claude-haiku-4.5',
    'anthropic/claude-haiku-4.5',
    'deepseek-v4-flash',
    'deepseek/deepseek-v4-flash',
    'MiniMax-M2.7',
    'minimax/minimax-m2.7'
);
--> statement-breakpoint
UPDATE org_members_metadata
SET
    selected_model = CASE selected_model
        WHEN 'claude-haiku-4-5' THEN 'claude-sonnet-4-6'
        WHEN 'claude-haiku-4.5' THEN 'claude-sonnet-4-6'
        WHEN 'anthropic/claude-haiku-4.5' THEN 'claude-sonnet-4-6'
        WHEN 'deepseek-v4-flash' THEN 'deepseek-v4-pro'
        WHEN 'deepseek/deepseek-v4-flash' THEN 'deepseek-v4-pro'
        WHEN 'MiniMax-M2.7' THEN 'MiniMax-M3'
        WHEN 'minimax/minimax-m2.7' THEN 'MiniMax-M3'
    END,
    updated_at = NOW()
WHERE selected_model IN (
    'claude-haiku-4-5',
    'claude-haiku-4.5',
    'anthropic/claude-haiku-4.5',
    'deepseek-v4-flash',
    'deepseek/deepseek-v4-flash',
    'MiniMax-M2.7',
    'minimax/minimax-m2.7'
);
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp.vm0_remove_poor_agent_model_policies;
