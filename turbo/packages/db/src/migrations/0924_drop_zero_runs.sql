SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

DO $$
DECLARE
	target_table oid;
	external_constraints text[];
	user_triggers text[];
	transition_objects text[];
	routine_references text[];
	rewrite_dependents text[];
	other_dependents text[];
BEGIN
	target_table := to_regclass('public.zero_runs');
	IF target_table IS NULL THEN
		RAISE EXCEPTION
			'Stage 6 expected public.zero_runs to be an existing permanent table';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM "pg_class" AS "table_row"
		INNER JOIN "pg_namespace" AS "namespace_row"
			ON "namespace_row"."oid" = "table_row"."relnamespace"
		WHERE "table_row"."oid" = target_table
			AND "namespace_row"."nspname" = 'public'
			AND "table_row"."relname" = 'zero_runs'
			AND "table_row"."relkind" = 'r'
			AND "table_row"."relpersistence" = 'p'
	) THEN
		RAISE EXCEPTION
			'Stage 6 expected public.zero_runs to be an ordinary permanent table';
	END IF;

	SELECT array_agg(
		pg_describe_object('pg_constraint'::regclass, "constraint_row"."oid", 0)
		ORDER BY pg_describe_object(
			'pg_constraint'::regclass,
			"constraint_row"."oid",
			0
		)
	)
	INTO external_constraints
	FROM "pg_constraint" AS "constraint_row"
	WHERE "constraint_row"."conrelid" <> target_table
		AND (
			"constraint_row"."confrelid" = target_table
			OR EXISTS (
				SELECT 1
				FROM "pg_depend" AS "dependency_row"
				WHERE "dependency_row"."classid" = 'pg_constraint'::regclass
					AND "dependency_row"."objid" = "constraint_row"."oid"
					AND "dependency_row"."refclassid" = 'pg_class'::regclass
					AND "dependency_row"."refobjid" = target_table
			)
		);

	IF external_constraints IS NOT NULL THEN
		RAISE EXCEPTION
			'Stage 6 found external constraints depending on public.zero_runs: %',
			external_constraints;
	END IF;

	SELECT array_agg(
		format(
			'%I on public.zero_runs -> %I.%I(%s)',
			"trigger_row"."tgname",
			"namespace_row"."nspname",
			"routine_row"."proname",
			pg_get_function_identity_arguments("routine_row"."oid")
		)
		ORDER BY "trigger_row"."tgname"
	)
	INTO user_triggers
	FROM "pg_trigger" AS "trigger_row"
	INNER JOIN "pg_proc" AS "routine_row"
		ON "routine_row"."oid" = "trigger_row"."tgfoid"
	INNER JOIN "pg_namespace" AS "namespace_row"
		ON "namespace_row"."oid" = "routine_row"."pronamespace"
	WHERE "trigger_row"."tgrelid" = target_table
		AND NOT "trigger_row"."tgisinternal";

	IF user_triggers IS NOT NULL THEN
		RAISE EXCEPTION
			'Stage 6 found non-internal triggers on public.zero_runs: %',
			user_triggers;
	END IF;

	WITH "stale_transition_objects" AS (
		SELECT pg_describe_object(
			'pg_proc'::regclass,
			"routine_row"."oid",
			0
		) AS "description"
		FROM "pg_proc" AS "routine_row"
		INNER JOIN "pg_namespace" AS "namespace_row"
			ON "namespace_row"."oid" = "routine_row"."pronamespace"
		WHERE "namespace_row"."nspname" = 'public'
			AND "routine_row"."proname" IN (
				'sync_zero_run_metadata_to_agent_runs',
				'backfill_agent_run_metadata_stage2'
			)

		UNION ALL

		SELECT pg_describe_object(
			'pg_trigger'::regclass,
			"trigger_row"."oid",
			0
		) AS "description"
		FROM "pg_trigger" AS "trigger_row"
		WHERE NOT "trigger_row"."tgisinternal"
			AND "trigger_row"."tgname" = 'sync_zero_run_metadata_to_agent_runs'
	)
	SELECT array_agg("description" ORDER BY "description")
	INTO transition_objects
	FROM "stale_transition_objects";

	IF transition_objects IS NOT NULL THEN
		RAISE EXCEPTION
			'Stage 6 found retired zero_runs transition objects: %',
			transition_objects;
	END IF;

	WITH "stored_routines" AS MATERIALIZED (
		SELECT
			"routine_row"."oid",
			pg_get_functiondef("routine_row"."oid") AS "definition"
		FROM "pg_proc" AS "routine_row"
		INNER JOIN "pg_namespace" AS "namespace_row"
			ON "namespace_row"."oid" = "routine_row"."pronamespace"
		WHERE "routine_row"."prokind" IN ('f', 'p')
			AND "namespace_row"."nspname" NOT IN (
				'pg_catalog',
				'information_schema'
			)
			AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'
	)
	SELECT array_agg(
		pg_describe_object('pg_proc'::regclass, "oid", 0)
		ORDER BY pg_describe_object('pg_proc'::regclass, "oid", 0)
	)
	INTO routine_references
	FROM "stored_routines"
	WHERE "definition" ILIKE '%zero_runs%';

	IF routine_references IS NOT NULL THEN
		RAISE EXCEPTION
			'Stage 6 found stored routines referencing public.zero_runs: %',
			routine_references;
	END IF;

	SELECT array_agg(
		DISTINCT pg_describe_object(
			'pg_rewrite'::regclass,
			"rewrite_row"."oid",
			0
		)
		ORDER BY pg_describe_object(
			'pg_rewrite'::regclass,
			"rewrite_row"."oid",
			0
		)
	)
	INTO rewrite_dependents
	FROM "pg_depend" AS "dependency_row"
	INNER JOIN "pg_rewrite" AS "rewrite_row"
		ON "dependency_row"."classid" = 'pg_rewrite'::regclass
		AND "dependency_row"."objid" = "rewrite_row"."oid"
	WHERE "dependency_row"."refclassid" = 'pg_class'::regclass
		AND "dependency_row"."refobjid" = target_table;

	IF rewrite_dependents IS NOT NULL THEN
		RAISE EXCEPTION
			'Stage 6 found views, materialized views, or rules depending on public.zero_runs: %',
			rewrite_dependents;
	END IF;

	SELECT array_agg(
		DISTINCT pg_describe_object(
			"dependency_row"."classid",
			"dependency_row"."objid",
			"dependency_row"."objsubid"
		)
		ORDER BY pg_describe_object(
			"dependency_row"."classid",
			"dependency_row"."objid",
			"dependency_row"."objsubid"
		)
	)
	INTO other_dependents
	FROM "pg_depend" AS "dependency_row"
	WHERE "dependency_row"."refclassid" = 'pg_class'::regclass
		AND "dependency_row"."refobjid" = target_table
		AND NOT (
			(
				"dependency_row"."classid" = 'pg_constraint'::regclass
				AND EXISTS (
					SELECT 1
					FROM "pg_constraint" AS "constraint_row"
					WHERE "constraint_row"."oid" = "dependency_row"."objid"
						AND "constraint_row"."conrelid" = target_table
						AND "constraint_row"."contype" IN ('p', 'c', 'f', 'n')
				)
			)
			OR (
				"dependency_row"."classid" = 'pg_class'::regclass
				AND EXISTS (
					SELECT 1
					FROM "pg_index" AS "index_row"
					WHERE "index_row"."indexrelid" = "dependency_row"."objid"
						AND "index_row"."indrelid" = target_table
				)
			)
			OR (
				"dependency_row"."classid" = 'pg_class'::regclass
				AND "dependency_row"."objid" = (
					SELECT "table_row"."reltoastrelid"
					FROM "pg_class" AS "table_row"
					WHERE "table_row"."oid" = target_table
				)
			)
			OR (
				"dependency_row"."classid" = 'pg_attrdef'::regclass
				AND EXISTS (
					SELECT 1
					FROM "pg_attrdef" AS "default_row"
					WHERE "default_row"."oid" = "dependency_row"."objid"
						AND "default_row"."adrelid" = target_table
				)
			)
			OR (
				"dependency_row"."classid" = 'pg_trigger'::regclass
				AND EXISTS (
					SELECT 1
					FROM "pg_trigger" AS "trigger_row"
					WHERE "trigger_row"."oid" = "dependency_row"."objid"
						AND "trigger_row"."tgrelid" = target_table
						AND "trigger_row"."tgisinternal"
				)
			)
			OR (
				"dependency_row"."classid" = 'pg_type'::regclass
				AND EXISTS (
					SELECT 1
					FROM "pg_type" AS "type_row"
					WHERE "type_row"."oid" = "dependency_row"."objid"
						AND "type_row"."typrelid" = target_table
				)
			)
		);

	IF other_dependents IS NOT NULL THEN
		RAISE EXCEPTION
			'Stage 6 found non-allowlisted pg_depend objects for public.zero_runs: %',
			other_dependents;
	END IF;
END;
$$;--> statement-breakpoint

DROP TABLE public.zero_runs;--> statement-breakpoint

DO $$
BEGIN
	IF to_regclass('public.zero_runs') IS NOT NULL THEN
		RAISE EXCEPTION 'Stage 6 failed to drop public.zero_runs';
	END IF;
END;
$$;
