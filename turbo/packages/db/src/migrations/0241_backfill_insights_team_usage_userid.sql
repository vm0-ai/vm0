-- Backfill userId into insightsDaily teamUsage entries.
-- Commit 57d4cdfa3 added userId to teamUsage and changed the frontend
-- to match personal credit usage by userId instead of name.
-- Old aggregated records lack userId, causing "Your Credit Usage" to show 0.
--
-- Name matching logic mirrors resolveUserNames():
--   name = user_cache.name ?? split_part(email, '@', 1) ?? email
-- Scoped to same org via credit_usage to avoid cross-org name collisions.
UPDATE insights_daily id
SET data = jsonb_set(
  id.data,
  '{teamUsage}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN elem->>'userId' IS NOT NULL AND elem->>'userId' != '' THEN elem
        ELSE elem || jsonb_build_object('userId', COALESCE(
          (SELECT uc.user_id
           FROM user_cache uc
           WHERE (
             uc.name = elem->>'name'
             OR split_part(uc.email, '@', 1) = elem->>'name'
             OR uc.email = elem->>'name'
           )
           AND EXISTS (
             SELECT 1 FROM credit_usage cu
             WHERE cu.user_id = uc.user_id AND cu.org_id = id.org_id
           )
           LIMIT 1),
          ''
        ))
      END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(id.data->'teamUsage') AS elem
  ),
  true
),
updated_at = now()
WHERE jsonb_typeof(id.data->'teamUsage') = 'array'
  AND jsonb_array_length(id.data->'teamUsage') > 0
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(id.data->'teamUsage') AS elem
    WHERE elem->>'userId' IS NULL
  );
