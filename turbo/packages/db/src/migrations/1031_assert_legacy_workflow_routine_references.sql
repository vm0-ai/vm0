DO $workflow_routine_reference_assertion$
DECLARE
	bounded_diagnostic jsonb;
	match_count bigint;
BEGIN
	WITH legacy_identifier(identifier) AS (
		VALUES
			('zero_workflows'),
			('zero_workflow_automations'),
			('zero_workflow_webhook_automations'),
			('zero_workflow_webhook_deliveries'),
			('zero_workflow_github_processed_events'),
			('zero_workflow_strapi_automations')
	), routine_definition AS MATERIALIZED (
		SELECT
			"routine"."oid" AS routine_oid,
			"namespace"."nspname" AS schema_name,
			"routine"."proname" AS routine_name,
			"language"."lanname" AS language_name,
			pg_catalog.pg_get_functiondef("routine"."oid") AS definition
		FROM pg_catalog.pg_proc AS "routine"
		INNER JOIN pg_catalog.pg_namespace AS "namespace"
			ON "namespace"."oid" = "routine"."pronamespace"
		INNER JOIN pg_catalog.pg_language AS "language"
			ON "language"."oid" = "routine"."prolang"
		WHERE "routine"."prokind" IN ('f', 'p')
			AND "language"."lanname" IN ('sql', 'plpgsql')
			AND "namespace"."nspname" <> 'information_schema'
			AND "namespace"."nspname" !~ '^pg_'
	), routine_match AS MATERIALIZED (
		SELECT
			"routine_definition"."routine_oid",
			"routine_definition"."schema_name",
			"routine_definition"."routine_name",
			"routine_definition"."language_name",
			"legacy_identifier"."identifier" AS legacy_identifier
		FROM routine_definition
		CROSS JOIN legacy_identifier
		WHERE pg_catalog.strpos(
			"routine_definition"."definition",
			pg_catalog.format('"%s"', "legacy_identifier"."identifier")
		) > 0
			OR pg_catalog.regexp_replace(
				"routine_definition"."definition",
				'"([^"]|"")*"',
				'',
				'g'
			) ~* pg_catalog.format(
				'(^|[^[:alnum:]_$"])%s([^[:alnum:]_$"]|$)',
				"legacy_identifier"."identifier"
			)
	), bounded_match AS (
		SELECT *
		FROM routine_match
		ORDER BY
			"schema_name" COLLATE "C",
			"routine_name" COLLATE "C",
			"routine_oid",
			"legacy_identifier" COLLATE "C"
		LIMIT 20
	)
	SELECT
		(SELECT pg_catalog.count(*) FROM routine_match),
		(
			SELECT pg_catalog.jsonb_agg(
				pg_catalog.jsonb_build_object(
					'schema', "schema_name",
					'routine', "routine_name",
					'oid', "routine_oid"::text,
					'language', "language_name",
					'matchedLegacyIdentifier', "legacy_identifier"
				)
				ORDER BY
					"schema_name" COLLATE "C",
					"routine_name" COLLATE "C",
					"routine_oid",
					"legacy_identifier" COLLATE "C"
			)
			FROM bounded_match
		)
	INTO match_count, bounded_diagnostic;

	IF match_count > 0 THEN
		RAISE EXCEPTION USING
			MESSAGE = pg_catalog.format(
				'workflow routine reference assertion found %s persisted legacy identifier match(es); diagnostic limited to first 20',
				match_count
			),
			DETAIL = bounded_diagnostic::text;
	END IF;
END $workflow_routine_reference_assertion$;
