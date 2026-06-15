-- Fix model ID format: replace dots with hyphens to match Anthropic API model IDs.
-- e.g. "claude-sonnet-4.6" → "claude-sonnet-4-6", "claude-opus-4.6" → "claude-opus-4-6"

UPDATE model_providers
SET selected_model = REPLACE(selected_model, '.', '-'),
    updated_at = NOW()
WHERE selected_model LIKE 'claude-%-4.6';

UPDATE vm0_api_keys
SET model = REPLACE(model, '.', '-'),
    updated_at = NOW()
WHERE model LIKE 'claude-%-4.6';

UPDATE credit_pricing
SET model = REPLACE(model, '.', '-'),
    updated_at = NOW()
WHERE model LIKE 'claude-%-4.6';

-- Backfill vm0 providers missing a selected_model with the default (sonnet).
UPDATE model_providers
SET selected_model = 'claude-sonnet-4-6',
    updated_at = NOW()
WHERE type = 'vm0'
  AND (selected_model IS NULL OR selected_model = '');
