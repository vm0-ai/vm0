-- Backfill userId into insightsDaily teamUsage entries.
-- Commit 57d4cdfa3 added userId to teamUsage and changed the frontend
-- to match personal credit usage by userId instead of name.
-- Old aggregated records lack userId, causing "Your Credit Usage" to show 0.
UPDATE insights_daily
SET data = jsonb_set(
  data,
  '{teamUsage}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN elem->>'userId' IS NOT NULL AND elem->>'userId' != '' THEN elem
        ELSE elem || jsonb_build_object('userId', COALESCE(
          (SELECT uc.user_id FROM user_cache uc WHERE uc.name = elem->>'name' LIMIT 1),
          ''
        ))
      END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(data->'teamUsage') AS elem
  ),
  true
),
updated_at = now()
WHERE jsonb_typeof(data->'teamUsage') = 'array'
  AND jsonb_array_length(data->'teamUsage') > 0
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(data->'teamUsage') AS elem
    WHERE elem->>'userId' IS NULL
  );
