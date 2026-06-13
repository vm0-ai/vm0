DROP TABLE IF EXISTS pg_temp.vm0_remove_claude_fable_5_policies;
--> statement-breakpoint
CREATE TEMP TABLE vm0_remove_claude_fable_5_policies (
    id uuid PRIMARY KEY,
    org_id text NOT NULL,
    was_default boolean NOT NULL,
    replacement_model varchar(255) NOT NULL,
    replacement_default_provider_type varchar(50) NOT NULL,
    replacement_credential_scope varchar(20) NOT NULL,
    replacement_model_provider_id uuid
);
--> statement-breakpoint
INSERT INTO vm0_remove_claude_fable_5_policies (
    id,
    org_id,
    was_default,
    replacement_model,
    replacement_default_provider_type,
    replacement_credential_scope,
    replacement_model_provider_id
)
SELECT
    id,
    org_id,
    is_default AS was_default,
    'claude-opus-4-8' AS replacement_model,
    default_provider_type AS replacement_default_provider_type,
    credential_scope AS replacement_credential_scope,
    model_provider_id AS replacement_model_provider_id
FROM org_model_policies
WHERE model = 'claude-fable-5';
--> statement-breakpoint
UPDATE org_model_policies AS deprecated
SET
    is_default = false,
    updated_at = NOW()
FROM vm0_remove_claude_fable_5_policies AS policy
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
FROM vm0_remove_claude_fable_5_policies AS policy
WHERE policy.was_default = true
  AND replacement.org_id = policy.org_id
  AND replacement.model = policy.replacement_model
  AND replacement.id <> policy.id;
--> statement-breakpoint
DELETE FROM org_model_policies AS deprecated
USING vm0_remove_claude_fable_5_policies AS policy
WHERE deprecated.id = policy.id
  AND EXISTS (
      SELECT 1
      FROM org_model_policies AS replacement
      WHERE replacement.org_id = policy.org_id
        AND replacement.model = policy.replacement_model
        AND replacement.id <> policy.id
  );
--> statement-breakpoint
UPDATE org_model_policies AS policy
SET
    model = replacement.replacement_model,
    default_provider_type = replacement.replacement_default_provider_type,
    credential_scope = replacement.replacement_credential_scope,
    model_provider_id = replacement.replacement_model_provider_id,
    updated_at = NOW()
FROM vm0_remove_claude_fable_5_policies AS replacement
WHERE policy.id = replacement.id;
--> statement-breakpoint
UPDATE model_providers
SET
    selected_model = CASE
        WHEN type IN ('openrouter-api-key', 'vercel-ai-gateway') THEN 'anthropic/claude-opus-4.8'
        ELSE 'claude-opus-4-8'
    END,
    updated_at = NOW()
WHERE selected_model IN (
    'claude-fable-5',
    'anthropic/claude-fable-5',
    'fable'
);
--> statement-breakpoint
UPDATE zero_agents
SET
    selected_model = 'claude-opus-4-8',
    updated_at = NOW()
WHERE selected_model IN (
    'claude-fable-5',
    'anthropic/claude-fable-5',
    'fable'
);
--> statement-breakpoint
UPDATE chat_threads
SET
    selected_model = 'claude-opus-4-8',
    updated_at = NOW()
WHERE selected_model IN (
    'claude-fable-5',
    'anthropic/claude-fable-5',
    'fable'
);
--> statement-breakpoint
UPDATE org_members_metadata
SET
    selected_model = 'claude-opus-4-8',
    updated_at = NOW()
WHERE selected_model IN (
    'claude-fable-5',
    'anthropic/claude-fable-5',
    'fable'
);
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp.vm0_remove_claude_fable_5_policies;
