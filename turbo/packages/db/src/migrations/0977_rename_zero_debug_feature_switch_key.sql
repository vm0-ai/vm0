-- The `zeroDebug` feature switch is now `okouDebug`. Persisted overrides live
-- in the `user_feature_switches.switches` jsonb object, keyed by the literal
-- switch value, so renaming the enum alone would make every stored override
-- read as unset. Rewrite the key in place and keep its boolean value, for both
-- per-user rows and org-scoped rows stored under the `__org__` sentinel user.
UPDATE "user_feature_switches"
SET
  "switches" = ("switches" - 'zeroDebug')
    || jsonb_build_object('okouDebug', "switches" -> 'zeroDebug'),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "switches" ? 'zeroDebug';
