ALTER TABLE "browser_sessions" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
WITH "browser_creation_runs" AS (
	SELECT
		"browser"."id" AS "browser_id",
		COALESCE(
			(
				SELECT "instance"."run_id"
				FROM "browser_session_instances" AS "instance"
				WHERE "instance"."chat_thread_id" = "browser"."chat_thread_id"
					AND "instance"."created_at" >= "browser"."created_at"
				ORDER BY "instance"."created_at", "instance"."provider_session_id"
				LIMIT 1
			),
			"browser"."run_id"
		) AS "run_id"
	FROM "browser_sessions" AS "browser"
),
"browser_creation_brands" AS (
	SELECT DISTINCT ON ("creation_run"."browser_id")
		"creation_run"."browser_id",
		"callback"."payload" ->> 'publicBrand' AS "public_brand"
	FROM "browser_creation_runs" AS "creation_run"
	INNER JOIN "agent_run_callbacks" AS "callback"
		ON "callback"."run_id" = "creation_run"."run_id"
	WHERE "callback"."internal_kind" = 'chat'
		AND "callback"."payload" ->> 'publicBrand' IN ('vm0', 'okou')
	ORDER BY "creation_run"."browser_id", "callback"."created_at", "callback"."id"
)
UPDATE "browser_sessions" AS "browser"
SET "public_brand" = "creation"."public_brand"
FROM "browser_creation_brands" AS "creation"
WHERE "browser"."id" = "creation"."browser_id";
