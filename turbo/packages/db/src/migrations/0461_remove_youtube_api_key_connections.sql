DROP TABLE IF EXISTS pg_temp.vm0_youtube_api_key_connections;
--> statement-breakpoint
CREATE TEMP TABLE vm0_youtube_api_key_connections ON COMMIT DROP AS
SELECT
    org_id,
    user_id
FROM connectors
WHERE type = 'youtube'
  AND auth_method = 'api-token';
--> statement-breakpoint
DELETE FROM secrets AS target
USING vm0_youtube_api_key_connections AS youtube
WHERE target.org_id = youtube.org_id
  AND target.user_id = youtube.user_id
  AND target.type = 'connector'
  AND target.name IN (
      'YOUTUBE_TOKEN',
      'YOUTUBE_ACCESS_TOKEN',
      'YOUTUBE_REFRESH_TOKEN'
  );
--> statement-breakpoint
DELETE FROM variables AS target
USING vm0_youtube_api_key_connections AS youtube
WHERE target.org_id = youtube.org_id
  AND target.user_id = youtube.user_id
  AND target.type = 'connector'
  AND target.name IN (
      'YOUTUBE_TOKEN',
      'YOUTUBE_ACCESS_TOKEN',
      'YOUTUBE_REFRESH_TOKEN'
  );
--> statement-breakpoint
DELETE FROM connectors AS target
USING vm0_youtube_api_key_connections AS youtube
WHERE target.org_id = youtube.org_id
  AND target.user_id = youtube.user_id
  AND target.type = 'youtube'
  AND target.auth_method = 'api-token';
--> statement-breakpoint
DROP TABLE IF EXISTS pg_temp.vm0_youtube_api_key_connections;
