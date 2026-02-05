-- Migration: Change unique constraint to include type
-- This allows same secret name to exist with different types (user vs model-provider)
-- Fixes: https://github.com/vm0-ai/vm0/issues/2432

-- Drop the old unique index that only uses (scope_id, name)
DROP INDEX IF EXISTS idx_secrets_scope_name;

-- Create new unique index with type included (IF NOT EXISTS for idempotency)
-- This allows: (scope_123, "API_KEY", "user") and (scope_123, "API_KEY", "model-provider") to coexist
CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_scope_name_type ON secrets (scope_id, name, type);
