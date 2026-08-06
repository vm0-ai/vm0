WITH "ranked_vm0_api_keys" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "vendor"
			ORDER BY
				CASE WHEN "label" = 'dev-seed' THEN 0 ELSE 1 END,
				"updated_at" DESC,
				"created_at" DESC,
				"id" DESC
		) AS "row_rank"
	FROM "vm0_api_keys"
)
DELETE FROM "vm0_api_keys"
USING "ranked_vm0_api_keys"
WHERE "vm0_api_keys"."id" = "ranked_vm0_api_keys"."id"
	AND "ranked_vm0_api_keys"."row_rank" > 1;
