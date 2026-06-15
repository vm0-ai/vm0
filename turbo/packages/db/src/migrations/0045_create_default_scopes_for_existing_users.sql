-- Create default scopes for existing users who don't have one
-- Uses random slug generation (migration doesn't need determinism)
-- Format: user-{8 hex chars} e.g., user-a1b2c3d4

INSERT INTO "scopes" ("slug", "type", "owner_id")
SELECT
  'user-' || left(md5(random()::text), 8),
  'personal',
  ct.user_id
FROM (
  SELECT DISTINCT user_id FROM cli_tokens
  WHERE user_id NOT IN (
    SELECT owner_id FROM scopes WHERE owner_id IS NOT NULL
  )
) ct
ON CONFLICT ("slug") DO NOTHING;
