-- Collapse dual-default rows introduced by #11545 (framework-scoped
-- assignDefaultIfFirst). Keep the earliest-created `is_default = true` row
-- per (org_id, user_id) and clear the rest. Required before adding the
-- partial unique index in 0334.
UPDATE model_providers
SET is_default = false, updated_at = NOW()
WHERE is_default = true
  AND id NOT IN (
    SELECT DISTINCT ON (org_id, user_id) id
    FROM model_providers
    WHERE is_default = true
    ORDER BY org_id, user_id, created_at ASC
  );
