UPDATE "user_feature_switches"
SET
  "switches" = "switches" - 'claudeSessionPruning',
  "updated_at" = NOW()
WHERE "switches" ? 'claudeSessionPruning';
