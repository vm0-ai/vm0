DROP TABLE IF EXISTS pg_temp.vm0_retire_gpt_5_4_policies;
--> statement-breakpoint
CREATE TEMP TABLE vm0_retire_gpt_5_4_policies (
    id uuid PRIMARY KEY,
    org_id text NOT NULL,
    was_default boolean NOT NULL,
    keep_if_missing_luna boolean NOT NULL,
    replacement_default_provider_type varchar(50) NOT NULL,
    replacement_credential_scope varchar(20) NOT NULL,
    replacement_model_provider_id uuid
);
--> statement-breakpoint
INSERT INTO vm0_retire_gpt_5_4_policies (
    id,
    org_id,
    was_default,
    keep_if_missing_luna,
    replacement_default_provider_type,
    replacement_credential_scope,
    replacement_model_provider_id
)
SELECT
    id,
    org_id,
    is_default AS was_default,
    ROW_NUMBER() OVER (
        PARTITION BY org_id
        ORDER BY
            is_default DESC,
            CASE model
                WHEN 'gpt-5.4' THEN 0
                ELSE 1
            END,
            id
    ) = 1 AS keep_if_missing_luna,
    CASE
        WHEN default_provider_type IN (
            'vm0',
            'openai-api-key',
            'codex-oauth-token'
        ) THEN default_provider_type
        ELSE 'vm0'
    END AS replacement_default_provider_type,
    CASE
        WHEN default_provider_type IN (
            'vm0',
            'openai-api-key',
            'codex-oauth-token'
        ) THEN credential_scope
        ELSE 'org'
    END AS replacement_credential_scope,
    CASE
        WHEN default_provider_type IN (
            'vm0',
            'openai-api-key',
            'codex-oauth-token'
        ) THEN model_provider_id
        ELSE NULL
    END AS replacement_model_provider_id
FROM org_model_policies
WHERE model IN ('gpt-5.4', 'gpt-5.4-mini');
--> statement-breakpoint
UPDATE org_model_policies AS retired
SET
    is_default = false,
    updated_at = NOW()
FROM vm0_retire_gpt_5_4_policies AS policy
WHERE retired.id = policy.id
  AND policy.was_default = true
  AND EXISTS (
      SELECT 1
      FROM org_model_policies AS luna
      WHERE luna.org_id = policy.org_id
        AND luna.model = 'gpt-5.6-luna'
        AND luna.id <> policy.id
  );
--> statement-breakpoint
UPDATE org_model_policies AS luna
SET
    is_default = true,
    default_provider_type = policy.replacement_default_provider_type,
    credential_scope = policy.replacement_credential_scope,
    model_provider_id = policy.replacement_model_provider_id,
    updated_at = NOW()
FROM vm0_retire_gpt_5_4_policies AS policy
WHERE policy.was_default = true
  AND luna.org_id = policy.org_id
  AND luna.model = 'gpt-5.6-luna'
  AND luna.id <> policy.id;
--> statement-breakpoint
DELETE FROM org_model_policies AS retired
USING vm0_retire_gpt_5_4_policies AS policy
WHERE retired.id = policy.id
  AND EXISTS (
      SELECT 1
      FROM org_model_policies AS luna
      WHERE luna.org_id = policy.org_id
        AND luna.model = 'gpt-5.6-luna'
        AND luna.id <> policy.id
  );
--> statement-breakpoint
DELETE FROM org_model_policies AS duplicate
USING vm0_retire_gpt_5_4_policies AS policy
WHERE duplicate.id = policy.id
  AND policy.keep_if_missing_luna = false;
--> statement-breakpoint
UPDATE org_model_policies AS policy
SET
    model = 'gpt-5.6-luna',
    default_provider_type = replacement.replacement_default_provider_type,
    credential_scope = replacement.replacement_credential_scope,
    model_provider_id = replacement.replacement_model_provider_id,
    updated_at = NOW()
FROM vm0_retire_gpt_5_4_policies AS replacement
WHERE policy.id = replacement.id;
--> statement-breakpoint
UPDATE model_providers
SET
    selected_model = CASE
        WHEN type IN (
            'openrouter-codex',
            'vercel-ai-gateway-codex'
        ) THEN 'openai/gpt-5.5'
        ELSE 'gpt-5.6-luna'
    END,
    updated_at = NOW()
WHERE selected_model IN (
    'gpt-5.4',
    'gpt-5.4-mini',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini'
);
--> statement-breakpoint
INSERT INTO chat_thread_events (
    user_id,
    org_id,
    chat_thread_id,
    kind,
    agent_compose_id,
    selected_model
)
SELECT
    thread.user_id,
    compose.org_id,
    thread.id,
    'model_selection_updated',
    thread.agent_compose_id,
    'gpt-5.6-luna'
FROM chat_threads AS thread
INNER JOIN agent_composes AS compose
    ON compose.id = thread.agent_compose_id
WHERE thread.selected_model IN (
    'gpt-5.4',
    'gpt-5.4-mini',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini'
);
--> statement-breakpoint
UPDATE zero_agents
SET
    selected_model = 'gpt-5.6-luna',
    updated_at = NOW()
WHERE selected_model IN (
    'gpt-5.4',
    'gpt-5.4-mini',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini'
);
--> statement-breakpoint
UPDATE chat_threads
SET
    selected_model = 'gpt-5.6-luna',
    updated_at = NOW()
WHERE selected_model IN (
    'gpt-5.4',
    'gpt-5.4-mini',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini'
);
--> statement-breakpoint
UPDATE org_members_metadata
SET
    selected_model = 'gpt-5.6-luna',
    updated_at = NOW()
WHERE selected_model IN (
    'gpt-5.4',
    'gpt-5.4-mini',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini'
);
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp.vm0_retire_gpt_5_4_policies;
