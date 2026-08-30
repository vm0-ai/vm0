-- Reconcile cooldown writes made by pre-#28911 APIs after the expansion
-- snapshot. The later deadline remains authoritative when both tables contain
-- the same route identity.
INSERT INTO "built_in_model_candidate_cooldown" (
  "selected_model",
  "provider_type",
  "upstream_model",
  "unavailable_until"
)
SELECT
  "selected_model",
  "provider_type",
  "upstream_model",
  "unavailable_until"
FROM "managed_model_candidate_cooldown"
ON CONFLICT ("selected_model", "provider_type", "upstream_model")
DO UPDATE SET
  "unavailable_until" = GREATEST(
    "built_in_model_candidate_cooldown"."unavailable_until",
    EXCLUDED."unavailable_until"
  );

-- Expand the persisted switch property before current code starts reading the
-- built-in name. Keep the legacy property for draining #28911 APIs and
-- rollback; #28915 owns its removal after this deployment drains.
UPDATE "user_feature_switches"
SET
  "switches" = "switches" || jsonb_build_object(
    'builtInModelProviderFallback',
    "switches" -> 'managedModelProviderFallback'
  ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "switches" ? 'managedModelProviderFallback'
  AND NOT "switches" ? 'builtInModelProviderFallback';
