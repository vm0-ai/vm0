WITH "parsed_slack_context" AS (
	SELECT
		"context"."id",
		"match_parts"[1] AS "channel_id",
		left(
			"match_parts"[2],
			length("match_parts"[2]) - 6
		) || '.' || right("match_parts"[2], 6) AS "message_ts"
	FROM "chat_slack_context" AS "context"
	CROSS JOIN LATERAL regexp_match(
		"context"."message_permalink",
		'/archives/([^/?#]+)/p([0-9]{7,})([/?#]|$)'
	) AS "permalink_match"("match_parts")
	WHERE "context"."channel_id" IS NULL
		AND "context"."message_ts" IS NULL
		AND "match_parts" IS NOT NULL
)
UPDATE "chat_slack_context" AS "context"
SET
	"channel_id" = "parsed_slack_context"."channel_id",
	"message_ts" = "parsed_slack_context"."message_ts"
FROM "parsed_slack_context"
WHERE "context"."id" = "parsed_slack_context"."id";
