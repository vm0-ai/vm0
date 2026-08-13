-- vm0:non-transactional
-- Foreground callers use mixed lock orders. This backfill locks only the
-- agent_runs target with SKIP LOCKED and never waits for a zero_runs source row.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
DO $$
DECLARE
	v_minimum_server_version_num CONSTANT integer := 170000;
	v_minimum_ledger_timestamp CONSTANT bigint := 1786617147388;
	v_expected_agent_only_digest CONSTANT text := '4418a1e0da8c1a2c34563a996d4b337c';
	v_expected_callback_digest CONSTANT text := '408462129a863fe84c3b51c9d6e6951b';
	v_accepted_agent_only_ids uuid[] := ARRAY[
		'0cad9bdf-0238-4c82-82f8-3299c5442fcc'::uuid,
		'1273ff1c-b25d-4c2f-9a2f-9d1746e3ccb6'::uuid,
		'5085b4b7-6f05-4712-9cc6-7da547edc8cc'::uuid,
		'515ac92c-e18c-45bb-ae29-2b19c7dc5868'::uuid,
		'5cb04070-8942-4cb3-b810-1ff9cb2b6e2b'::uuid,
		'5fa8690b-9507-4607-a035-68308b825f4e'::uuid,
		'6078841a-4b2d-414f-a175-31fa8db03fcc'::uuid,
		'89f5a328-cc73-4621-aadb-253c36d9d35f'::uuid,
		'8a30f583-7265-49c5-a434-c535c717caf7'::uuid,
		'9180c355-3a06-4efb-817e-866bf3bfaeac'::uuid,
		'9a3318e9-4a7e-4fc1-a204-0c5649159915'::uuid,
		'9be063a5-5388-4420-92fc-068e6f790b9e'::uuid,
		'b64e8f0b-c435-41a5-a34c-9226701a853e'::uuid,
		'c47d7c7e-3ee9-4393-9154-0bc791c75564'::uuid,
		'c564e0c2-ff22-4891-9326-bfe2b641050d'::uuid,
		'dc3c2273-d4d3-4f9c-8709-a0d0d1c3f540'::uuid
	];
	v_accepted_agent_only_id_texts text[];
	v_expected_inbound_fk_definitions text[] := ARRAY[
		'public.active_input_deliveries|active_input_deliveries_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.agent_run_callbacks|agent_run_callbacks_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.agent_run_queue|agent_run_queue_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.browser_sessions|browser_sessions_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.built_in_generation_jobs|built_in_generation_jobs_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.chat_output_materializations|chat_output_materializations_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.chat_threads|chat_threads_agent_session_run_id_agent_runs_id_fk|agent_session_run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.checkpoints|checkpoints_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.conversations|conversations_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.morning_brief_deliveries|morning_brief_deliveries_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.org_usage_allowance_windows|org_usage_allowance_windows_created_by_run_id_agent_runs_id_fk|created_by_run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.run_built_in_admissions|run_built_in_admissions_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.run_uploaded_files|run_uploaded_files_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.runner_job_queue|runner_job_queue_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.sandbox_telemetry|sandbox_telemetry_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.storage_version_lineage|storage_version_lineage_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.usage_allowance_allocations|usage_allowance_allocations_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.usage_event_hourly_rollup|usage_event_hourly_rollup_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.usage_event|usage_event_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.zero_runs|zero_runs_id_agent_runs_id_fk|id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true'
	];
	v_expected_non_fk_definitions text[] := ARRAY[
		'public.archived_task_runs|archived_run_id|text',
		'public.banking_access_audit_events|run_id|uuid',
		'public.browser_authorization_requests|run_id|uuid',
		'public.browser_session_instances|run_id|uuid',
		'public.chat_event_search_messages|run_id|uuid',
		'public.chat_events|run_id|uuid',
		'public.chat_threads|source_schedule_run_id|uuid',
		'public.computer_use_authorization_requests|run_id|uuid',
		'public.computer_use_command_audit_events|run_id|text',
		'public.computer_use_commands|run_id|text',
		'public.hosted_deployments|run_id|text',
		'public.hosted_sites|created_from_run_id|text',
		'public.zero_workflow_automations|last_run_id|uuid',
		'public.zero_workflow_webhook_deliveries|run_id|uuid'
	];
	v_actual_inbound_fk_definitions text[];
	v_actual_non_fk_definitions text[];
	v_actual_agent_only_ids uuid[];
	v_server_version_num integer;
	v_ledger_timestamp bigint;
	v_agent_run_count bigint;
	v_zero_run_count bigint;
	v_paired_count bigint;
	v_zero_only_count bigint;
	v_agent_only_count bigint;
	v_agent_only_digest text;
	v_invalid_source_count bigint;
	v_invalid_agent_only_shape_count bigint;
	v_callback_count bigint;
	v_callback_run_count bigint;
	v_callback_digest text;
	v_invalid_callback_shape_count bigint;
	v_inbound_fk_count integer;
	v_reviewed_non_fk_count integer;
	v_fk_dependency_match_count bigint := 0;
	v_non_fk_dependency_match_count bigint;
	v_dependency_count bigint;
	v_bridge_trigger_count integer;
	v_fk record;
	v_pristine boolean;
BEGIN
	SELECT current_setting('server_version_num')::integer
	INTO v_server_version_num;

	IF v_server_version_num < v_minimum_server_version_num THEN
		RAISE EXCEPTION 'Stage 2 preflight requires PostgreSQL server_version_num >= %, found %',
			v_minimum_server_version_num,
			v_server_version_num;
	END IF;

	SELECT max("created_at")
	INTO v_ledger_timestamp
	FROM "drizzle"."__drizzle_migrations";

	IF v_ledger_timestamp IS NULL OR v_ledger_timestamp < v_minimum_ledger_timestamp THEN
		RAISE EXCEPTION 'Stage 2 preflight requires migration ledger timestamp >= %, found %',
			v_minimum_ledger_timestamp,
			v_ledger_timestamp;
	END IF;

	SELECT count(*)
	INTO v_bridge_trigger_count
	FROM "pg_trigger" AS "trigger_row"
	INNER JOIN "pg_proc" AS "function_row"
		ON "function_row"."oid" = "trigger_row"."tgfoid"
	INNER JOIN "pg_namespace" AS "function_namespace"
		ON "function_namespace"."oid" = "function_row"."pronamespace"
	INNER JOIN "pg_language" AS "function_language"
		ON "function_language"."oid" = "function_row"."prolang"
	WHERE "trigger_row"."tgrelid" = 'public.zero_runs'::regclass
		AND "trigger_row"."tgname" = 'sync_zero_run_metadata_to_agent_runs'
		AND NOT "trigger_row"."tgisinternal"
		AND "trigger_row"."tgenabled" = 'O'
		AND "trigger_row"."tgtype" = 21
		AND "trigger_row"."tgnargs" = 0
		AND "trigger_row"."tgqual" IS NULL
		AND "trigger_row"."tgconstraint" = 0
		AND NOT "trigger_row"."tgdeferrable"
		AND NOT "trigger_row"."tginitdeferred"
		AND (
			SELECT array_agg(
				"trigger_attribute"."attname"
				ORDER BY "trigger_attribute"."attname"
			)
			FROM unnest("trigger_row"."tgattr"::smallint[])
				AS "trigger_key"("attnum")
			INNER JOIN "pg_attribute" AS "trigger_attribute"
				ON "trigger_attribute"."attrelid" = "trigger_row"."tgrelid"
				AND "trigger_attribute"."attnum" = "trigger_key"."attnum"
		) = ARRAY[
			'api_started_at',
			'autonomy_budget',
			'chat_thread_id',
			'codex_service_tier',
			'first_assistant_event_acknowledged_at',
			'goal_id',
			'model_provider',
			'model_provider_credential_scope',
			'model_provider_id',
			'selected_model',
			'selected_video_model',
			'summary',
			'trigger_brief',
			'trigger_source',
			'workflow_automation_id'
		]::name[]
		AND "function_namespace"."nspname" = 'public'
		AND "function_row"."proname" = 'sync_zero_run_metadata_to_agent_runs'
		AND "function_row"."pronargs" = 0
		AND "function_row"."prokind" = 'f'
		AND "function_row"."prorettype" = 'trigger'::regtype
		AND "function_language"."lanname" = 'plpgsql'
		AND "function_row"."provolatile" = 'v'
		AND "function_row"."proparallel" = 'u'
		AND NOT "function_row"."prosecdef"
		AND NOT "function_row"."proleakproof"
		AND md5("function_row"."prosrc") = '63665b45e2bb69f78d27ded47ef8f2d4';

	IF v_bridge_trigger_count <> 1 THEN
		RAISE EXCEPTION 'Stage 2 preflight found % exact enabled Stage 1 bridge triggers',
			v_bridge_trigger_count;
	END IF;

	SELECT
		(SELECT count(*) FROM "agent_runs"),
		(SELECT count(*) FROM "zero_runs"),
		(
			SELECT count(*)
			FROM "zero_runs" AS "zero_run"
			INNER JOIN "agent_runs" AS "agent_run"
				ON "agent_run"."id" = "zero_run"."id"
		),
		(
			SELECT count(*)
			FROM "zero_runs" AS "zero_run"
			LEFT JOIN "agent_runs" AS "agent_run"
				ON "agent_run"."id" = "zero_run"."id"
			WHERE "agent_run"."id" IS NULL
		)
	INTO
		v_agent_run_count,
		v_zero_run_count,
		v_paired_count,
		v_zero_only_count;

	SELECT
		count(*),
		md5(string_agg("agent_run"."id"::text, ',' ORDER BY "agent_run"."id")),
		array_agg("agent_run"."id" ORDER BY "agent_run"."id")
	INTO
		v_agent_only_count,
		v_agent_only_digest,
		v_actual_agent_only_ids
	FROM "agent_runs" AS "agent_run"
	LEFT JOIN "zero_runs" AS "zero_run"
		ON "zero_run"."id" = "agent_run"."id"
	WHERE "zero_run"."id" IS NULL;

	v_pristine := v_agent_run_count = 0 AND v_zero_run_count = 0;

	IF v_zero_only_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 preflight found % zero_runs-only rows',
			v_zero_only_count;
	END IF;

	IF v_paired_count <> v_zero_run_count THEN
		RAISE EXCEPTION 'Stage 2 preflight paired count % does not match zero_runs count %',
			v_paired_count,
			v_zero_run_count;
	END IF;

	IF v_pristine THEN
		IF v_agent_only_count <> 0 THEN
			RAISE EXCEPTION 'Stage 2 pristine preflight found % agent_runs-only rows',
				v_agent_only_count;
		END IF;
	ELSIF
		v_agent_only_count <> cardinality(v_accepted_agent_only_ids)
		OR v_agent_only_digest IS DISTINCT FROM v_expected_agent_only_digest
		OR v_actual_agent_only_ids IS DISTINCT FROM v_accepted_agent_only_ids
	THEN
		RAISE EXCEPTION 'Stage 2 preflight agent_runs-only set mismatch: count %, digest %',
			v_agent_only_count,
			v_agent_only_digest;
	END IF;

	SELECT count(*)
	INTO v_invalid_source_count
	FROM "zero_runs" AS "zero_run"
	LEFT JOIN "chat_threads" AS "chat_thread"
		ON "chat_thread"."id" = "zero_run"."chat_thread_id"
	LEFT JOIN "zero_workflow_automations" AS "workflow_automation"
		ON "workflow_automation"."id" = "zero_run"."workflow_automation_id"
	LEFT JOIN "thread_goals" AS "thread_goal"
		ON "thread_goal"."id" = "zero_run"."goal_id"
	WHERE "zero_run"."trigger_source" IS NULL
		OR "zero_run"."autonomy_budget" IS NULL
		OR "zero_run"."autonomy_budget" NOT BETWEEN 0 AND 10
		OR (
			"zero_run"."chat_thread_id" IS NOT NULL
			AND "chat_thread"."id" IS NULL
		)
		OR (
			"zero_run"."workflow_automation_id" IS NOT NULL
			AND "workflow_automation"."id" IS NULL
		)
		OR (
			"zero_run"."goal_id" IS NOT NULL
			AND "thread_goal"."id" IS NULL
		);

	IF v_invalid_source_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 preflight found % structurally invalid zero_runs rows',
			v_invalid_source_count;
	END IF;

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_actual_inbound_fk_definitions
	FROM (
		SELECT
			"source_namespace"."nspname" || '.' || "source_table"."relname" ||
			'|' || "constraint_row"."conname" ||
			'|' || (
				SELECT string_agg("source_attribute"."attname", ',' ORDER BY "source_key"."ordinality")
				FROM unnest("constraint_row"."conkey") WITH ORDINALITY AS "source_key"("attnum", "ordinality")
				INNER JOIN "pg_attribute" AS "source_attribute"
					ON "source_attribute"."attrelid" = "constraint_row"."conrelid"
					AND "source_attribute"."attnum" = "source_key"."attnum"
			) ||
			'|' || "target_namespace"."nspname" || '.' || "target_table"."relname" ||
			'|' || (
				SELECT string_agg("target_attribute"."attname", ',' ORDER BY "target_key"."ordinality")
				FROM unnest("constraint_row"."confkey") WITH ORDINALITY AS "target_key"("attnum", "ordinality")
				INNER JOIN "pg_attribute" AS "target_attribute"
					ON "target_attribute"."attrelid" = "constraint_row"."confrelid"
					AND "target_attribute"."attnum" = "target_key"."attnum"
			) ||
			'|update=' || "constraint_row"."confupdtype"::text ||
			'|delete=' || "constraint_row"."confdeltype"::text ||
			'|match=' || "constraint_row"."confmatchtype"::text ||
			'|deferrable=' || "constraint_row"."condeferrable"::text ||
			'|deferred=' || "constraint_row"."condeferred"::text ||
			'|validated=' || "constraint_row"."convalidated"::text AS "definition"
		FROM "pg_constraint" AS "constraint_row"
		INNER JOIN "pg_class" AS "source_table"
			ON "source_table"."oid" = "constraint_row"."conrelid"
		INNER JOIN "pg_namespace" AS "source_namespace"
			ON "source_namespace"."oid" = "source_table"."relnamespace"
		INNER JOIN "pg_class" AS "target_table"
			ON "target_table"."oid" = "constraint_row"."confrelid"
		INNER JOIN "pg_namespace" AS "target_namespace"
			ON "target_namespace"."oid" = "target_table"."relnamespace"
		WHERE "constraint_row"."contype" = 'f'
			AND "constraint_row"."confrelid" = 'public.agent_runs'::regclass
	) AS "inbound_fk_definition";

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_expected_inbound_fk_definitions
	FROM unnest(v_expected_inbound_fk_definitions) AS "definition";

	v_inbound_fk_count := coalesce(cardinality(v_actual_inbound_fk_definitions), 0);
	IF v_actual_inbound_fk_definitions IS DISTINCT FROM v_expected_inbound_fk_definitions THEN
		RAISE EXCEPTION 'Stage 2 preflight inbound agent_runs FK definitions drifted: expected %, found %',
			cardinality(v_expected_inbound_fk_definitions),
			v_inbound_fk_count;
	END IF;

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_actual_non_fk_definitions
	FROM (
		SELECT
			"table_namespace"."nspname" || '.' || "table_class"."relname" ||
			'|' || "attribute"."attname" ||
			'|' || format_type("attribute"."atttypid", "attribute"."atttypmod") AS "definition"
		FROM "pg_attribute" AS "attribute"
		INNER JOIN "pg_class" AS "table_class"
			ON "table_class"."oid" = "attribute"."attrelid"
		INNER JOIN "pg_namespace" AS "table_namespace"
			ON "table_namespace"."oid" = "table_class"."relnamespace"
		WHERE "table_namespace"."nspname" = 'public'
			AND "table_class"."relkind" IN ('r', 'p')
			AND "attribute"."attnum" > 0
			AND NOT "attribute"."attisdropped"
			AND (
				"attribute"."attname" = 'run_id'
				OR right("attribute"."attname", 7) = '_run_id'
			)
			AND NOT EXISTS (
				SELECT 1
				FROM "pg_constraint" AS "constraint_row"
				WHERE "constraint_row"."contype" = 'f'
					AND "constraint_row"."confrelid" = 'public.agent_runs'::regclass
					AND "constraint_row"."conrelid" = "attribute"."attrelid"
					AND "attribute"."attnum" = ANY("constraint_row"."conkey")
			)
	) AS "non_fk_definition";

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_expected_non_fk_definitions
	FROM unnest(v_expected_non_fk_definitions) AS "definition";

	v_reviewed_non_fk_count := coalesce(cardinality(v_actual_non_fk_definitions), 0);
	IF v_actual_non_fk_definitions IS DISTINCT FROM v_expected_non_fk_definitions THEN
		RAISE EXCEPTION 'Stage 2 preflight non-FK run-attribution definitions drifted: expected %, found %',
			cardinality(v_expected_non_fk_definitions),
			v_reviewed_non_fk_count;
	END IF;

	SELECT array_agg("id"::text ORDER BY "id")
	INTO v_accepted_agent_only_id_texts
	FROM unnest(v_accepted_agent_only_ids) AS "id";

	SELECT count(*)
	INTO v_invalid_agent_only_shape_count
	FROM "agent_runs" AS "agent_run"
	WHERE "agent_run"."id" = ANY(v_accepted_agent_only_ids)
		AND (
			"agent_run"."status" IS DISTINCT FROM 'failed'
			OR "agent_run"."created_at" < timestamp '2026-03-30 00:00:00'
			OR "agent_run"."created_at" >= timestamp '2026-04-09 00:00:00'
			OR "agent_run"."started_at" IS NOT NULL
			OR "agent_run"."sandbox_id" IS NOT NULL
			OR "agent_run"."last_event_sequence" IS NOT NULL
			OR "agent_run"."trigger_source" IS NOT NULL
			OR "agent_run"."autonomy_budget" IS NOT NULL
			OR "agent_run"."workflow_automation_id" IS NOT NULL
			OR "agent_run"."goal_id" IS NOT NULL
			OR "agent_run"."model_provider" IS NOT NULL
			OR "agent_run"."model_provider_id" IS NOT NULL
			OR "agent_run"."model_provider_credential_scope" IS NOT NULL
			OR "agent_run"."selected_model" IS NOT NULL
			OR "agent_run"."codex_service_tier" IS NOT NULL
			OR "agent_run"."selected_video_model" IS NOT NULL
			OR "agent_run"."chat_thread_id" IS NOT NULL
			OR "agent_run"."api_started_at" IS NOT NULL
			OR "agent_run"."first_assistant_event_acknowledged_at" IS NOT NULL
			OR "agent_run"."summary" IS NOT NULL
			OR "agent_run"."trigger_brief" IS NOT NULL
		);

	IF NOT v_pristine AND v_invalid_agent_only_shape_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 preflight found % accepted lifecycle rows with shape drift',
			v_invalid_agent_only_shape_count;
	END IF;

	SELECT
		count(*),
		count(DISTINCT "callback"."run_id"),
		md5(string_agg("callback"."id"::text, ',' ORDER BY "callback"."id")),
		count(*) FILTER (
			WHERE "callback"."status" IS DISTINCT FROM 'delivered'
				OR "callback"."attempts" IS DISTINCT FROM 1
				OR "callback"."last_attempt_at" IS NULL
				OR "callback"."delivered_at" IS NULL
				OR "callback"."last_error" IS NOT NULL
				OR "callback"."internal_kind" IS NOT NULL
		)
	INTO
		v_callback_count,
		v_callback_run_count,
		v_callback_digest,
		v_invalid_callback_shape_count
	FROM "agent_run_callbacks" AS "callback"
	WHERE "callback"."run_id" = ANY(v_accepted_agent_only_ids);

	IF v_pristine THEN
		IF v_callback_count <> 0 THEN
			RAISE EXCEPTION 'Stage 2 pristine preflight found % accepted-ID callbacks',
				v_callback_count;
		END IF;
	ELSIF
		v_callback_count <> 12
		OR v_callback_run_count <> 10
		OR v_callback_digest IS DISTINCT FROM v_expected_callback_digest
		OR v_invalid_callback_shape_count <> 0
	THEN
		RAISE EXCEPTION 'Stage 2 preflight callback exception mismatch: count %, run_count %, digest %, invalid_shape %',
			v_callback_count,
			v_callback_run_count,
			v_callback_digest,
			v_invalid_callback_shape_count;
	END IF;

	FOR v_fk IN
		SELECT
			"source_namespace"."nspname" AS "schema_name",
			"source_table"."relname" AS "table_name",
			"source_attribute"."attname" AS "column_name"
		FROM "pg_constraint" AS "constraint_row"
		INNER JOIN "pg_class" AS "source_table"
			ON "source_table"."oid" = "constraint_row"."conrelid"
		INNER JOIN "pg_namespace" AS "source_namespace"
			ON "source_namespace"."oid" = "source_table"."relnamespace"
		INNER JOIN "pg_attribute" AS "source_attribute"
			ON "source_attribute"."attrelid" = "constraint_row"."conrelid"
			AND "source_attribute"."attnum" = "constraint_row"."conkey"[1]
		WHERE "constraint_row"."contype" = 'f'
			AND "constraint_row"."confrelid" = 'public.agent_runs'::regclass
			AND cardinality("constraint_row"."conkey") = 1
			AND NOT (
				"source_namespace"."nspname" = 'public'
				AND "source_table"."relname" IN ('agent_run_callbacks', 'zero_runs')
			)
	LOOP
		EXECUTE format(
			'SELECT count(*) FROM %I.%I WHERE %I = ANY($1)',
			v_fk.schema_name,
			v_fk.table_name,
			v_fk.column_name
		)
		INTO v_dependency_count
		USING v_accepted_agent_only_ids;
		v_fk_dependency_match_count := v_fk_dependency_match_count + v_dependency_count;
	END LOOP;

	IF v_fk_dependency_match_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 preflight found % unexpected FK-backed dependencies',
			v_fk_dependency_match_count;
	END IF;

	SELECT count(*)
	INTO v_non_fk_dependency_match_count
	FROM (
		SELECT 1 FROM "archived_task_runs" WHERE "archived_run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "banking_access_audit_events" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "browser_authorization_requests" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "browser_session_instances" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "chat_event_search_messages" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "chat_events" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "chat_threads" WHERE "source_schedule_run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "computer_use_authorization_requests" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "computer_use_command_audit_events" WHERE "run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "computer_use_commands" WHERE "run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "hosted_deployments" WHERE "run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "hosted_sites" WHERE "created_from_run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "zero_workflow_automations" WHERE "last_run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "zero_workflow_webhook_deliveries" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
	) AS "non_fk_dependency";

	IF v_non_fk_dependency_match_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 preflight found % unexpected non-FK dependencies',
			v_non_fk_dependency_match_count;
	END IF;

	RAISE NOTICE
		'Stage 2 agent-run metadata preflight: ledger=%, agent_runs=%, zero_runs=%, paired=%, zero_only=%, invalid_sources=%, agent_only=%, agent_only_digest=%, callbacks=%, callback_runs=%, callback_digest=%, inbound_fks=%, reviewed_non_fk_fields=%, fk_dependency_matches=%, non_fk_dependency_matches=%, bridge_triggers=%',
		v_ledger_timestamp,
		v_agent_run_count,
		v_zero_run_count,
		v_paired_count,
		v_zero_only_count,
		v_invalid_source_count,
		v_agent_only_count,
		v_agent_only_digest,
		v_callback_count,
		v_callback_run_count,
		v_callback_digest,
		v_inbound_fk_count,
		v_reviewed_non_fk_count,
		v_fk_dependency_match_count,
		v_non_fk_dependency_match_count,
		v_bridge_trigger_count;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "backfill_agent_run_metadata_stage2"(
	p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
	v_scan_after uuid := NULL;
	v_updated_ids uuid[];
	v_batch_count integer;
	v_remaining boolean;
	v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
	IF
		p_no_progress_timeout IS NULL
		OR p_no_progress_timeout <= interval '0 seconds'
		OR p_no_progress_timeout > interval '30 seconds'
	THEN
		RAISE EXCEPTION 'Stage 2 backfill no-progress timeout must be between 0 and 30 seconds';
	END IF;

	-- statement_timeout is armed before CALL arrives, so PostgreSQL 17
	-- transaction_timeout is the effective bound for each internal segment.
	SET LOCAL lock_timeout = '1s';
	SET LOCAL transaction_timeout = '5min';

	LOOP
		WITH "batch" AS MATERIALIZED (
			SELECT
				"target"."id",
				"candidate"."trigger_source",
				"candidate"."autonomy_budget",
				"candidate"."workflow_automation_id",
				"candidate"."goal_id",
				"candidate"."model_provider",
				"candidate"."model_provider_id",
				"candidate"."model_provider_credential_scope",
				"candidate"."selected_model",
				"candidate"."codex_service_tier",
				"candidate"."selected_video_model",
				"candidate"."chat_thread_id",
				"candidate"."api_started_at",
				"candidate"."first_assistant_event_acknowledged_at",
				"candidate"."summary",
				"candidate"."trigger_brief"
			FROM "agent_runs" AS "target"
			INNER JOIN "zero_runs" AS "candidate"
				ON "candidate"."id" = "target"."id"
			WHERE (v_scan_after IS NULL OR "target"."id" > v_scan_after)
				AND ROW(
					"target"."trigger_source",
					"target"."autonomy_budget",
					"target"."workflow_automation_id",
					"target"."goal_id",
					"target"."model_provider",
					"target"."model_provider_id",
					"target"."model_provider_credential_scope",
					"target"."selected_model",
					"target"."codex_service_tier",
					"target"."selected_video_model",
					"target"."chat_thread_id",
					"target"."api_started_at",
					"target"."first_assistant_event_acknowledged_at",
					"target"."summary",
					"target"."trigger_brief"
				) IS DISTINCT FROM ROW(
					"candidate"."trigger_source",
					"candidate"."autonomy_budget",
					"candidate"."workflow_automation_id",
					"candidate"."goal_id",
					"candidate"."model_provider",
					"candidate"."model_provider_id",
					"candidate"."model_provider_credential_scope",
					"candidate"."selected_model",
					"candidate"."codex_service_tier",
					"candidate"."selected_video_model",
					"candidate"."chat_thread_id",
					"candidate"."api_started_at",
					"candidate"."first_assistant_event_acknowledged_at",
					"candidate"."summary",
					"candidate"."trigger_brief"
				)
			ORDER BY "target"."id"
			LIMIT 500
			FOR UPDATE OF "target" SKIP LOCKED
		),
		"updated" AS (
			UPDATE "agent_runs" AS "target"
			SET
				"trigger_source" = "batch"."trigger_source",
				"autonomy_budget" = "batch"."autonomy_budget",
				"workflow_automation_id" = "batch"."workflow_automation_id",
				"goal_id" = "batch"."goal_id",
				"model_provider" = "batch"."model_provider",
				"model_provider_id" = "batch"."model_provider_id",
				"model_provider_credential_scope" = "batch"."model_provider_credential_scope",
				"selected_model" = "batch"."selected_model",
				"codex_service_tier" = "batch"."codex_service_tier",
				"selected_video_model" = "batch"."selected_video_model",
				"chat_thread_id" = "batch"."chat_thread_id",
				"api_started_at" = "batch"."api_started_at",
				"first_assistant_event_acknowledged_at" = "batch"."first_assistant_event_acknowledged_at",
				"summary" = "batch"."summary",
				"trigger_brief" = "batch"."trigger_brief"
			FROM "batch"
			WHERE "target"."id" = "batch"."id"
				AND ROW(
					"target"."trigger_source",
					"target"."autonomy_budget",
					"target"."workflow_automation_id",
					"target"."goal_id",
					"target"."model_provider",
					"target"."model_provider_id",
					"target"."model_provider_credential_scope",
					"target"."selected_model",
					"target"."codex_service_tier",
					"target"."selected_video_model",
					"target"."chat_thread_id",
					"target"."api_started_at",
					"target"."first_assistant_event_acknowledged_at",
					"target"."summary",
					"target"."trigger_brief"
				) IS DISTINCT FROM ROW(
					"batch"."trigger_source",
					"batch"."autonomy_budget",
					"batch"."workflow_automation_id",
					"batch"."goal_id",
					"batch"."model_provider",
					"batch"."model_provider_id",
					"batch"."model_provider_credential_scope",
					"batch"."selected_model",
					"batch"."codex_service_tier",
					"batch"."selected_video_model",
					"batch"."chat_thread_id",
					"batch"."api_started_at",
					"batch"."first_assistant_event_acknowledged_at",
					"batch"."summary",
					"batch"."trigger_brief"
				)
			RETURNING "target"."id"
		)
		SELECT coalesce(array_agg("id" ORDER BY "id"), ARRAY[]::uuid[])
		INTO v_updated_ids
		FROM "updated";

		v_batch_count := cardinality(v_updated_ids);
		IF v_batch_count > 0 THEN
			v_scan_after := v_updated_ids[v_batch_count];
			v_no_progress_started_at := clock_timestamp();
		END IF;

		COMMIT;
		SET LOCAL lock_timeout = '1s';
		SET LOCAL transaction_timeout = '5min';

		IF v_batch_count > 0 THEN
			PERFORM pg_sleep(0.05);
			CONTINUE;
		END IF;

		SELECT EXISTS (
			SELECT 1
			FROM "zero_runs" AS "candidate"
			INNER JOIN "agent_runs" AS "target"
				ON "target"."id" = "candidate"."id"
			WHERE ROW(
				"target"."trigger_source",
				"target"."autonomy_budget",
				"target"."workflow_automation_id",
				"target"."goal_id",
				"target"."model_provider",
				"target"."model_provider_id",
				"target"."model_provider_credential_scope",
				"target"."selected_model",
				"target"."codex_service_tier",
				"target"."selected_video_model",
				"target"."chat_thread_id",
				"target"."api_started_at",
				"target"."first_assistant_event_acknowledged_at",
				"target"."summary",
				"target"."trigger_brief"
			) IS DISTINCT FROM ROW(
				"candidate"."trigger_source",
				"candidate"."autonomy_budget",
				"candidate"."workflow_automation_id",
				"candidate"."goal_id",
				"candidate"."model_provider",
				"candidate"."model_provider_id",
				"candidate"."model_provider_credential_scope",
				"candidate"."selected_model",
				"candidate"."codex_service_tier",
				"candidate"."selected_video_model",
				"candidate"."chat_thread_id",
				"candidate"."api_started_at",
				"candidate"."first_assistant_event_acknowledged_at",
				"candidate"."summary",
				"candidate"."trigger_brief"
			)
		)
		INTO v_remaining;

		IF NOT v_remaining THEN
			EXIT;
		END IF;

		IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
			RAISE EXCEPTION 'Stage 2 backfill made no progress for % while eligible rows remained',
				p_no_progress_timeout;
		END IF;

		v_scan_after := NULL;
		PERFORM pg_sleep(0.05);
	END LOOP;
END;
$$;
--> statement-breakpoint
CALL "backfill_agent_run_metadata_stage2"(interval '30 seconds');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_agent_run_metadata_stage2"(interval);
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_index record;
	v_relation_kind "char";
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	FOR v_index IN
		SELECT *
		FROM (
			VALUES
				(
					'idx_agent_runs_chat_thread_id_stage2_invalid',
					'CREATE INDEX idx_agent_runs_chat_thread_id_stage2_invalid ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)'
				)
		) AS "index_spec"("name", "definition")
	LOOP
		SELECT
			"index_class"."relkind",
			pg_get_indexdef("index_class"."oid"),
			"index_row"."indisready",
			"index_row"."indisvalid"
		INTO v_relation_kind, v_definition, v_ready, v_valid
		FROM "pg_class" AS "index_class"
		INNER JOIN "pg_namespace" AS "index_namespace"
			ON "index_namespace"."oid" = "index_class"."relnamespace"
		LEFT JOIN "pg_index" AS "index_row"
			ON "index_row"."indexrelid" = "index_class"."oid"
		WHERE "index_namespace"."nspname" = 'public'
			AND "index_class"."relname" = v_index.name;

		IF FOUND AND (
			v_relation_kind <> 'i'
			OR v_definition IS DISTINCT FROM v_index.definition
			OR v_ready IS NULL
			OR v_valid IS NULL
			OR v_valid
		) THEN
			RAISE EXCEPTION 'Stage 2 invalid-index recovery artifact % has conflicting definition or state',
				v_index.name;
		END IF;
	END LOOP;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_chat_thread_id_stage2_invalid";
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_index record;
	v_relation_kind "char";
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	FOR v_index IN
		SELECT *
		FROM (
			VALUES
				(
					'idx_agent_runs_chat_thread_id',
					'idx_agent_runs_chat_thread_id_stage2_invalid',
					'CREATE INDEX idx_agent_runs_chat_thread_id ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)'
				)
		) AS "index_spec"("name", "recovery_name", "definition")
	LOOP
		SELECT
			"index_class"."relkind",
			pg_get_indexdef("index_class"."oid"),
			"index_row"."indisready",
			"index_row"."indisvalid"
		INTO v_relation_kind, v_definition, v_ready, v_valid
		FROM "pg_class" AS "index_class"
		INNER JOIN "pg_namespace" AS "index_namespace"
			ON "index_namespace"."oid" = "index_class"."relnamespace"
		LEFT JOIN "pg_index" AS "index_row"
			ON "index_row"."indexrelid" = "index_class"."oid"
		WHERE "index_namespace"."nspname" = 'public'
			AND "index_class"."relname" = v_index.name;

		IF FOUND THEN
			IF
				v_relation_kind <> 'i'
				OR v_definition IS DISTINCT FROM v_index.definition
			THEN
				RAISE EXCEPTION 'Stage 2 index % has a conflicting definition',
					v_index.name;
			END IF;

			IF NOT v_ready OR NOT v_valid THEN
				EXECUTE format(
					'ALTER INDEX %I.%I RENAME TO %I',
					'public',
					v_index.name,
					v_index.recovery_name
				);
			END IF;
		END IF;
	END LOOP;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_chat_thread_id_stage2_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runs_chat_thread_id"
ON "agent_runs" USING btree ("chat_thread_id")
WHERE "chat_thread_id" IS NOT NULL;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	SELECT
		pg_get_indexdef("index_class"."oid"),
		"index_row"."indisready",
		"index_row"."indisvalid"
	INTO v_definition, v_ready, v_valid
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	INNER JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = 'idx_agent_runs_chat_thread_id'
		AND "index_class"."relkind" = 'i';

	IF
		NOT FOUND
		OR v_definition IS DISTINCT FROM 'CREATE INDEX idx_agent_runs_chat_thread_id ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)'
		OR NOT v_ready
		OR NOT v_valid
	THEN
		RAISE EXCEPTION 'Stage 2 index idx_agent_runs_chat_thread_id is not exact, ready, and valid';
	END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_relation_kind "char";
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	SELECT
		"index_class"."relkind",
		pg_get_indexdef("index_class"."oid"),
		"index_row"."indisready",
		"index_row"."indisvalid"
	INTO v_relation_kind, v_definition, v_ready, v_valid
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	LEFT JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = 'idx_agent_runs_workflow_automation_stage2_invalid';

	IF FOUND AND (
		v_relation_kind <> 'i'
		OR v_definition IS DISTINCT FROM 'CREATE INDEX idx_agent_runs_workflow_automation_stage2_invalid ON public.agent_runs USING btree (workflow_automation_id) WHERE (workflow_automation_id IS NOT NULL)'
		OR v_ready IS NULL
		OR v_valid IS NULL
		OR v_valid
	) THEN
		RAISE EXCEPTION 'Stage 2 invalid-index recovery artifact idx_agent_runs_workflow_automation_stage2_invalid has conflicting definition or state';
	END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_workflow_automation_stage2_invalid";
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_relation_kind "char";
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	SELECT
		"index_class"."relkind",
		pg_get_indexdef("index_class"."oid"),
		"index_row"."indisready",
		"index_row"."indisvalid"
	INTO v_relation_kind, v_definition, v_ready, v_valid
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	LEFT JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = 'idx_agent_runs_workflow_automation';

	IF FOUND THEN
		IF
			v_relation_kind <> 'i'
			OR v_definition IS DISTINCT FROM 'CREATE INDEX idx_agent_runs_workflow_automation ON public.agent_runs USING btree (workflow_automation_id) WHERE (workflow_automation_id IS NOT NULL)'
		THEN
			RAISE EXCEPTION 'Stage 2 index idx_agent_runs_workflow_automation has a conflicting definition';
		END IF;

		IF NOT v_ready OR NOT v_valid THEN
			ALTER INDEX "public"."idx_agent_runs_workflow_automation"
				RENAME TO "idx_agent_runs_workflow_automation_stage2_invalid";
		END IF;
	END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_workflow_automation_stage2_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runs_workflow_automation"
ON "agent_runs" USING btree ("workflow_automation_id")
WHERE "workflow_automation_id" IS NOT NULL;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	SELECT
		pg_get_indexdef("index_class"."oid"),
		"index_row"."indisready",
		"index_row"."indisvalid"
	INTO v_definition, v_ready, v_valid
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	INNER JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = 'idx_agent_runs_workflow_automation'
		AND "index_class"."relkind" = 'i';

	IF
		NOT FOUND
		OR v_definition IS DISTINCT FROM 'CREATE INDEX idx_agent_runs_workflow_automation ON public.agent_runs USING btree (workflow_automation_id) WHERE (workflow_automation_id IS NOT NULL)'
		OR NOT v_ready
		OR NOT v_valid
	THEN
		RAISE EXCEPTION 'Stage 2 index idx_agent_runs_workflow_automation is not exact, ready, and valid';
	END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_relation_kind "char";
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	SELECT
		"index_class"."relkind",
		pg_get_indexdef("index_class"."oid"),
		"index_row"."indisready",
		"index_row"."indisvalid"
	INTO v_relation_kind, v_definition, v_ready, v_valid
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	LEFT JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = 'idx_agent_runs_goal_stage2_invalid';

	IF FOUND AND (
		v_relation_kind <> 'i'
		OR v_definition IS DISTINCT FROM 'CREATE INDEX idx_agent_runs_goal_stage2_invalid ON public.agent_runs USING btree (goal_id) WHERE (goal_id IS NOT NULL)'
		OR v_ready IS NULL
		OR v_valid IS NULL
		OR v_valid
	) THEN
		RAISE EXCEPTION 'Stage 2 invalid-index recovery artifact idx_agent_runs_goal_stage2_invalid has conflicting definition or state';
	END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_goal_stage2_invalid";
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_relation_kind "char";
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	SELECT
		"index_class"."relkind",
		pg_get_indexdef("index_class"."oid"),
		"index_row"."indisready",
		"index_row"."indisvalid"
	INTO v_relation_kind, v_definition, v_ready, v_valid
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	LEFT JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = 'idx_agent_runs_goal';

	IF FOUND THEN
		IF
			v_relation_kind <> 'i'
			OR v_definition IS DISTINCT FROM 'CREATE INDEX idx_agent_runs_goal ON public.agent_runs USING btree (goal_id) WHERE (goal_id IS NOT NULL)'
		THEN
			RAISE EXCEPTION 'Stage 2 index idx_agent_runs_goal has a conflicting definition';
		END IF;

		IF NOT v_ready OR NOT v_valid THEN
			ALTER INDEX "public"."idx_agent_runs_goal"
				RENAME TO "idx_agent_runs_goal_stage2_invalid";
		END IF;
	END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_goal_stage2_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runs_goal"
ON "agent_runs" USING btree ("goal_id")
WHERE "goal_id" IS NOT NULL;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_definition text;
	v_ready boolean;
	v_valid boolean;
BEGIN
	SELECT
		pg_get_indexdef("index_class"."oid"),
		"index_row"."indisready",
		"index_row"."indisvalid"
	INTO v_definition, v_ready, v_valid
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	INNER JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = 'idx_agent_runs_goal'
		AND "index_class"."relkind" = 'i';

	IF
		NOT FOUND
		OR v_definition IS DISTINCT FROM 'CREATE INDEX idx_agent_runs_goal ON public.agent_runs USING btree (goal_id) WHERE (goal_id IS NOT NULL)'
		OR NOT v_ready
		OR NOT v_valid
	THEN
		RAISE EXCEPTION 'Stage 2 index idx_agent_runs_goal is not exact, ready, and valid';
	END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
	v_constraint record;
	v_definition text;
BEGIN
	FOR v_constraint IN
		SELECT *
		FROM (
			VALUES
				(
					'agent_runs_chat_thread_id_chat_threads_id_fk',
					'FOREIGN KEY (chat_thread_id) REFERENCES chat_threads(id) ON DELETE SET NULL'
				),
				(
					'agent_runs_workflow_automation_id_zero_workflow_automations_id_',
					'FOREIGN KEY (workflow_automation_id) REFERENCES zero_workflow_automations(id) ON DELETE SET NULL'
				),
				(
					'agent_runs_goal_id_thread_goals_id_fk',
					'FOREIGN KEY (goal_id) REFERENCES thread_goals(id) ON DELETE SET NULL'
				),
				(
					'agent_runs_autonomy_budget_check',
					'CHECK (autonomy_budget >= 0 AND autonomy_budget <= 10)'
				)
		) AS "constraint_spec"("name", "definition")
	LOOP
		SELECT pg_get_constraintdef("constraint_row"."oid", true)
		INTO v_definition
		FROM "pg_constraint" AS "constraint_row"
		WHERE "constraint_row"."conrelid" = 'public.agent_runs'::regclass
			AND "constraint_row"."conname" = v_constraint.name;

		IF FOUND THEN
			IF regexp_replace(v_definition, ' NOT VALID$', '') IS DISTINCT FROM v_constraint.definition THEN
				RAISE EXCEPTION 'Stage 2 constraint % has a conflicting definition: %',
					v_constraint.name,
					v_definition;
			END IF;
		ELSE
			EXECUTE format(
				'ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID',
				'public',
				'agent_runs',
				v_constraint.name,
				v_constraint.definition
			);
		END IF;
	END LOOP;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_chat_thread_id_chat_threads_id_fk";
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_workflow_automation_id_zero_workflow_automations_id_";
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_goal_id_thread_goals_id_fk";
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_autonomy_budget_check";
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
DO $$
DECLARE
	v_expected_agent_only_digest CONSTANT text := '4418a1e0da8c1a2c34563a996d4b337c';
	v_expected_callback_digest CONSTANT text := '408462129a863fe84c3b51c9d6e6951b';
	v_accepted_agent_only_ids uuid[] := ARRAY[
		'0cad9bdf-0238-4c82-82f8-3299c5442fcc'::uuid,
		'1273ff1c-b25d-4c2f-9a2f-9d1746e3ccb6'::uuid,
		'5085b4b7-6f05-4712-9cc6-7da547edc8cc'::uuid,
		'515ac92c-e18c-45bb-ae29-2b19c7dc5868'::uuid,
		'5cb04070-8942-4cb3-b810-1ff9cb2b6e2b'::uuid,
		'5fa8690b-9507-4607-a035-68308b825f4e'::uuid,
		'6078841a-4b2d-414f-a175-31fa8db03fcc'::uuid,
		'89f5a328-cc73-4621-aadb-253c36d9d35f'::uuid,
		'8a30f583-7265-49c5-a434-c535c717caf7'::uuid,
		'9180c355-3a06-4efb-817e-866bf3bfaeac'::uuid,
		'9a3318e9-4a7e-4fc1-a204-0c5649159915'::uuid,
		'9be063a5-5388-4420-92fc-068e6f790b9e'::uuid,
		'b64e8f0b-c435-41a5-a34c-9226701a853e'::uuid,
		'c47d7c7e-3ee9-4393-9154-0bc791c75564'::uuid,
		'c564e0c2-ff22-4891-9326-bfe2b641050d'::uuid,
		'dc3c2273-d4d3-4f9c-8709-a0d0d1c3f540'::uuid
	];
	v_accepted_agent_only_id_texts text[];
	v_expected_inbound_fk_definitions text[] := ARRAY[
		'public.active_input_deliveries|active_input_deliveries_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.agent_run_callbacks|agent_run_callbacks_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.agent_run_queue|agent_run_queue_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.browser_sessions|browser_sessions_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.built_in_generation_jobs|built_in_generation_jobs_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.chat_output_materializations|chat_output_materializations_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.chat_threads|chat_threads_agent_session_run_id_agent_runs_id_fk|agent_session_run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.checkpoints|checkpoints_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.conversations|conversations_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.morning_brief_deliveries|morning_brief_deliveries_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.org_usage_allowance_windows|org_usage_allowance_windows_created_by_run_id_agent_runs_id_fk|created_by_run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.run_built_in_admissions|run_built_in_admissions_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.run_uploaded_files|run_uploaded_files_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.runner_job_queue|runner_job_queue_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.sandbox_telemetry|sandbox_telemetry_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.storage_version_lineage|storage_version_lineage_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true',
		'public.usage_allowance_allocations|usage_allowance_allocations_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.usage_event_hourly_rollup|usage_event_hourly_rollup_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.usage_event|usage_event_run_id_agent_runs_id_fk|run_id|public.agent_runs|id|update=a|delete=n|match=s|deferrable=false|deferred=false|validated=true',
		'public.zero_runs|zero_runs_id_agent_runs_id_fk|id|public.agent_runs|id|update=a|delete=c|match=s|deferrable=false|deferred=false|validated=true'
	];
	v_expected_non_fk_definitions text[] := ARRAY[
		'public.archived_task_runs|archived_run_id|text',
		'public.banking_access_audit_events|run_id|uuid',
		'public.browser_authorization_requests|run_id|uuid',
		'public.browser_session_instances|run_id|uuid',
		'public.chat_event_search_messages|run_id|uuid',
		'public.chat_events|run_id|uuid',
		'public.chat_threads|source_schedule_run_id|uuid',
		'public.computer_use_authorization_requests|run_id|uuid',
		'public.computer_use_command_audit_events|run_id|text',
		'public.computer_use_commands|run_id|text',
		'public.hosted_deployments|run_id|text',
		'public.hosted_sites|created_from_run_id|text',
		'public.zero_workflow_automations|last_run_id|uuid',
		'public.zero_workflow_webhook_deliveries|run_id|uuid'
	];
	v_actual_inbound_fk_definitions text[];
	v_actual_non_fk_definitions text[];
	v_actual_agent_only_ids uuid[];
	v_agent_run_count bigint;
	v_zero_run_count bigint;
	v_paired_count bigint;
	v_zero_only_count bigint;
	v_agent_only_count bigint;
	v_agent_only_digest text;
	v_metadata_mismatch_count bigint;
	v_invalid_source_count bigint;
	v_invalid_agent_only_shape_count bigint;
	v_callback_count bigint;
	v_callback_run_count bigint;
	v_callback_digest text;
	v_invalid_callback_shape_count bigint;
	v_inbound_fk_count integer;
	v_reviewed_non_fk_count integer;
	v_fk_dependency_match_count bigint := 0;
	v_non_fk_dependency_match_count bigint;
	v_dependency_count bigint;
	v_ready_valid_index_count integer;
	v_recovery_index_count integer;
	v_validated_constraint_count integer;
	v_bridge_trigger_count integer;
	v_fk record;
	v_pristine boolean;
BEGIN
	SELECT
		(SELECT count(*) FROM "agent_runs"),
		(SELECT count(*) FROM "zero_runs"),
		(
			SELECT count(*)
			FROM "zero_runs" AS "zero_run"
			INNER JOIN "agent_runs" AS "agent_run"
				ON "agent_run"."id" = "zero_run"."id"
		),
		(
			SELECT count(*)
			FROM "zero_runs" AS "zero_run"
			LEFT JOIN "agent_runs" AS "agent_run"
				ON "agent_run"."id" = "zero_run"."id"
			WHERE "agent_run"."id" IS NULL
		)
	INTO
		v_agent_run_count,
		v_zero_run_count,
		v_paired_count,
		v_zero_only_count;

	SELECT
		count(*),
		md5(string_agg("agent_run"."id"::text, ',' ORDER BY "agent_run"."id")),
		array_agg("agent_run"."id" ORDER BY "agent_run"."id")
	INTO
		v_agent_only_count,
		v_agent_only_digest,
		v_actual_agent_only_ids
	FROM "agent_runs" AS "agent_run"
	LEFT JOIN "zero_runs" AS "zero_run"
		ON "zero_run"."id" = "agent_run"."id"
	WHERE "zero_run"."id" IS NULL;

	v_pristine := v_agent_run_count = 0 AND v_zero_run_count = 0;
	IF v_zero_only_count <> 0 OR v_paired_count <> v_zero_run_count THEN
		RAISE EXCEPTION 'Stage 2 final validation found zero-only or pairing drift';
	END IF;

	SELECT count(*)
	INTO v_invalid_source_count
	FROM "zero_runs" AS "zero_run"
	LEFT JOIN "chat_threads" AS "chat_thread"
		ON "chat_thread"."id" = "zero_run"."chat_thread_id"
	LEFT JOIN "zero_workflow_automations" AS "workflow_automation"
		ON "workflow_automation"."id" = "zero_run"."workflow_automation_id"
	LEFT JOIN "thread_goals" AS "thread_goal"
		ON "thread_goal"."id" = "zero_run"."goal_id"
	WHERE "zero_run"."trigger_source" IS NULL
		OR "zero_run"."autonomy_budget" IS NULL
		OR "zero_run"."autonomy_budget" NOT BETWEEN 0 AND 10
		OR (
			"zero_run"."chat_thread_id" IS NOT NULL
			AND "chat_thread"."id" IS NULL
		)
		OR (
			"zero_run"."workflow_automation_id" IS NOT NULL
			AND "workflow_automation"."id" IS NULL
		)
		OR (
			"zero_run"."goal_id" IS NOT NULL
			AND "thread_goal"."id" IS NULL
		);

	IF v_invalid_source_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % structurally invalid zero_runs rows',
			v_invalid_source_count;
	END IF;

	IF v_pristine THEN
		IF v_agent_only_count <> 0 THEN
			RAISE EXCEPTION 'Stage 2 final pristine validation found % agent_runs-only rows',
				v_agent_only_count;
		END IF;
	ELSIF
		v_agent_only_count <> cardinality(v_accepted_agent_only_ids)
		OR v_agent_only_digest IS DISTINCT FROM v_expected_agent_only_digest
		OR v_actual_agent_only_ids IS DISTINCT FROM v_accepted_agent_only_ids
	THEN
		RAISE EXCEPTION 'Stage 2 final agent_runs-only set mismatch: count %, digest %',
			v_agent_only_count,
			v_agent_only_digest;
	END IF;

	SELECT count(*)
	INTO v_metadata_mismatch_count
	FROM "zero_runs" AS "zero_run"
	INNER JOIN "agent_runs" AS "agent_run"
		ON "agent_run"."id" = "zero_run"."id"
	WHERE ROW(
		"agent_run"."trigger_source",
		"agent_run"."autonomy_budget",
		"agent_run"."workflow_automation_id",
		"agent_run"."goal_id",
		"agent_run"."model_provider",
		"agent_run"."model_provider_id",
		"agent_run"."model_provider_credential_scope",
		"agent_run"."selected_model",
		"agent_run"."codex_service_tier",
		"agent_run"."selected_video_model",
		"agent_run"."chat_thread_id",
		"agent_run"."api_started_at",
		"agent_run"."first_assistant_event_acknowledged_at",
		"agent_run"."summary",
		"agent_run"."trigger_brief"
	) IS DISTINCT FROM ROW(
		"zero_run"."trigger_source",
		"zero_run"."autonomy_budget",
		"zero_run"."workflow_automation_id",
		"zero_run"."goal_id",
		"zero_run"."model_provider",
		"zero_run"."model_provider_id",
		"zero_run"."model_provider_credential_scope",
		"zero_run"."selected_model",
		"zero_run"."codex_service_tier",
		"zero_run"."selected_video_model",
		"zero_run"."chat_thread_id",
		"zero_run"."api_started_at",
		"zero_run"."first_assistant_event_acknowledged_at",
		"zero_run"."summary",
		"zero_run"."trigger_brief"
	);

	IF v_metadata_mismatch_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % metadata mismatches',
			v_metadata_mismatch_count;
	END IF;

	SELECT count(*)
	INTO v_invalid_agent_only_shape_count
	FROM "agent_runs" AS "agent_run"
	WHERE "agent_run"."id" = ANY(v_accepted_agent_only_ids)
		AND (
			"agent_run"."status" IS DISTINCT FROM 'failed'
			OR "agent_run"."created_at" < timestamp '2026-03-30 00:00:00'
			OR "agent_run"."created_at" >= timestamp '2026-04-09 00:00:00'
			OR "agent_run"."started_at" IS NOT NULL
			OR "agent_run"."sandbox_id" IS NOT NULL
			OR "agent_run"."last_event_sequence" IS NOT NULL
			OR "agent_run"."trigger_source" IS NOT NULL
			OR "agent_run"."autonomy_budget" IS NOT NULL
			OR "agent_run"."workflow_automation_id" IS NOT NULL
			OR "agent_run"."goal_id" IS NOT NULL
			OR "agent_run"."model_provider" IS NOT NULL
			OR "agent_run"."model_provider_id" IS NOT NULL
			OR "agent_run"."model_provider_credential_scope" IS NOT NULL
			OR "agent_run"."selected_model" IS NOT NULL
			OR "agent_run"."codex_service_tier" IS NOT NULL
			OR "agent_run"."selected_video_model" IS NOT NULL
			OR "agent_run"."chat_thread_id" IS NOT NULL
			OR "agent_run"."api_started_at" IS NOT NULL
			OR "agent_run"."first_assistant_event_acknowledged_at" IS NOT NULL
			OR "agent_run"."summary" IS NOT NULL
			OR "agent_run"."trigger_brief" IS NOT NULL
		);

	IF NOT v_pristine AND v_invalid_agent_only_shape_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % accepted lifecycle rows with shape drift',
			v_invalid_agent_only_shape_count;
	END IF;

	SELECT
		count(*),
		count(DISTINCT "callback"."run_id"),
		md5(string_agg("callback"."id"::text, ',' ORDER BY "callback"."id")),
		count(*) FILTER (
			WHERE "callback"."status" IS DISTINCT FROM 'delivered'
				OR "callback"."attempts" IS DISTINCT FROM 1
				OR "callback"."last_attempt_at" IS NULL
				OR "callback"."delivered_at" IS NULL
				OR "callback"."last_error" IS NOT NULL
				OR "callback"."internal_kind" IS NOT NULL
		)
	INTO
		v_callback_count,
		v_callback_run_count,
		v_callback_digest,
		v_invalid_callback_shape_count
	FROM "agent_run_callbacks" AS "callback"
	WHERE "callback"."run_id" = ANY(v_accepted_agent_only_ids);

	IF v_pristine THEN
		IF v_callback_count <> 0 THEN
			RAISE EXCEPTION 'Stage 2 final pristine validation found % accepted-ID callbacks',
				v_callback_count;
		END IF;
	ELSIF
		v_callback_count <> 12
		OR v_callback_run_count <> 10
		OR v_callback_digest IS DISTINCT FROM v_expected_callback_digest
		OR v_invalid_callback_shape_count <> 0
	THEN
		RAISE EXCEPTION 'Stage 2 final callback exception mismatch: count %, run_count %, digest %, invalid_shape %',
			v_callback_count,
			v_callback_run_count,
			v_callback_digest,
			v_invalid_callback_shape_count;
	END IF;

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_actual_inbound_fk_definitions
	FROM (
		SELECT
			"source_namespace"."nspname" || '.' || "source_table"."relname" ||
			'|' || "constraint_row"."conname" ||
			'|' || (
				SELECT string_agg("source_attribute"."attname", ',' ORDER BY "source_key"."ordinality")
				FROM unnest("constraint_row"."conkey") WITH ORDINALITY AS "source_key"("attnum", "ordinality")
				INNER JOIN "pg_attribute" AS "source_attribute"
					ON "source_attribute"."attrelid" = "constraint_row"."conrelid"
					AND "source_attribute"."attnum" = "source_key"."attnum"
			) ||
			'|' || "target_namespace"."nspname" || '.' || "target_table"."relname" ||
			'|' || (
				SELECT string_agg("target_attribute"."attname", ',' ORDER BY "target_key"."ordinality")
				FROM unnest("constraint_row"."confkey") WITH ORDINALITY AS "target_key"("attnum", "ordinality")
				INNER JOIN "pg_attribute" AS "target_attribute"
					ON "target_attribute"."attrelid" = "constraint_row"."confrelid"
					AND "target_attribute"."attnum" = "target_key"."attnum"
			) ||
			'|update=' || "constraint_row"."confupdtype"::text ||
			'|delete=' || "constraint_row"."confdeltype"::text ||
			'|match=' || "constraint_row"."confmatchtype"::text ||
			'|deferrable=' || "constraint_row"."condeferrable"::text ||
			'|deferred=' || "constraint_row"."condeferred"::text ||
			'|validated=' || "constraint_row"."convalidated"::text AS "definition"
		FROM "pg_constraint" AS "constraint_row"
		INNER JOIN "pg_class" AS "source_table"
			ON "source_table"."oid" = "constraint_row"."conrelid"
		INNER JOIN "pg_namespace" AS "source_namespace"
			ON "source_namespace"."oid" = "source_table"."relnamespace"
		INNER JOIN "pg_class" AS "target_table"
			ON "target_table"."oid" = "constraint_row"."confrelid"
		INNER JOIN "pg_namespace" AS "target_namespace"
			ON "target_namespace"."oid" = "target_table"."relnamespace"
		WHERE "constraint_row"."contype" = 'f'
			AND "constraint_row"."confrelid" = 'public.agent_runs'::regclass
	) AS "inbound_fk_definition";

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_expected_inbound_fk_definitions
	FROM unnest(v_expected_inbound_fk_definitions) AS "definition";

	v_inbound_fk_count := coalesce(cardinality(v_actual_inbound_fk_definitions), 0);
	IF v_actual_inbound_fk_definitions IS DISTINCT FROM v_expected_inbound_fk_definitions THEN
		RAISE EXCEPTION 'Stage 2 final inbound agent_runs FK definitions drifted';
	END IF;

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_actual_non_fk_definitions
	FROM (
		SELECT
			"table_namespace"."nspname" || '.' || "table_class"."relname" ||
			'|' || "attribute"."attname" ||
			'|' || format_type("attribute"."atttypid", "attribute"."atttypmod") AS "definition"
		FROM "pg_attribute" AS "attribute"
		INNER JOIN "pg_class" AS "table_class"
			ON "table_class"."oid" = "attribute"."attrelid"
		INNER JOIN "pg_namespace" AS "table_namespace"
			ON "table_namespace"."oid" = "table_class"."relnamespace"
		WHERE "table_namespace"."nspname" = 'public'
			AND "table_class"."relkind" IN ('r', 'p')
			AND "attribute"."attnum" > 0
			AND NOT "attribute"."attisdropped"
			AND (
				"attribute"."attname" = 'run_id'
				OR right("attribute"."attname", 7) = '_run_id'
			)
			AND NOT EXISTS (
				SELECT 1
				FROM "pg_constraint" AS "constraint_row"
				WHERE "constraint_row"."contype" = 'f'
					AND "constraint_row"."confrelid" = 'public.agent_runs'::regclass
					AND "constraint_row"."conrelid" = "attribute"."attrelid"
					AND "attribute"."attnum" = ANY("constraint_row"."conkey")
			)
	) AS "non_fk_definition";

	SELECT array_agg("definition" ORDER BY "definition")
	INTO v_expected_non_fk_definitions
	FROM unnest(v_expected_non_fk_definitions) AS "definition";

	v_reviewed_non_fk_count := coalesce(cardinality(v_actual_non_fk_definitions), 0);
	IF v_actual_non_fk_definitions IS DISTINCT FROM v_expected_non_fk_definitions THEN
		RAISE EXCEPTION 'Stage 2 final non-FK run-attribution definitions drifted';
	END IF;

	SELECT array_agg("id"::text ORDER BY "id")
	INTO v_accepted_agent_only_id_texts
	FROM unnest(v_accepted_agent_only_ids) AS "id";

	FOR v_fk IN
		SELECT
			"source_namespace"."nspname" AS "schema_name",
			"source_table"."relname" AS "table_name",
			"source_attribute"."attname" AS "column_name"
		FROM "pg_constraint" AS "constraint_row"
		INNER JOIN "pg_class" AS "source_table"
			ON "source_table"."oid" = "constraint_row"."conrelid"
		INNER JOIN "pg_namespace" AS "source_namespace"
			ON "source_namespace"."oid" = "source_table"."relnamespace"
		INNER JOIN "pg_attribute" AS "source_attribute"
			ON "source_attribute"."attrelid" = "constraint_row"."conrelid"
			AND "source_attribute"."attnum" = "constraint_row"."conkey"[1]
		WHERE "constraint_row"."contype" = 'f'
			AND "constraint_row"."confrelid" = 'public.agent_runs'::regclass
			AND cardinality("constraint_row"."conkey") = 1
			AND NOT (
				"source_namespace"."nspname" = 'public'
				AND "source_table"."relname" IN ('agent_run_callbacks', 'zero_runs')
			)
	LOOP
		EXECUTE format(
			'SELECT count(*) FROM %I.%I WHERE %I = ANY($1)',
			v_fk.schema_name,
			v_fk.table_name,
			v_fk.column_name
		)
		INTO v_dependency_count
		USING v_accepted_agent_only_ids;
		v_fk_dependency_match_count := v_fk_dependency_match_count + v_dependency_count;
	END LOOP;

	IF v_fk_dependency_match_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % unexpected FK-backed dependencies',
			v_fk_dependency_match_count;
	END IF;

	SELECT count(*)
	INTO v_non_fk_dependency_match_count
	FROM (
		SELECT 1 FROM "archived_task_runs" WHERE "archived_run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "banking_access_audit_events" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "browser_authorization_requests" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "browser_session_instances" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "chat_event_search_messages" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "chat_events" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "chat_threads" WHERE "source_schedule_run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "computer_use_authorization_requests" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "computer_use_command_audit_events" WHERE "run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "computer_use_commands" WHERE "run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "hosted_deployments" WHERE "run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "hosted_sites" WHERE "created_from_run_id" = ANY(v_accepted_agent_only_id_texts)
		UNION ALL SELECT 1 FROM "zero_workflow_automations" WHERE "last_run_id" = ANY(v_accepted_agent_only_ids)
		UNION ALL SELECT 1 FROM "zero_workflow_webhook_deliveries" WHERE "run_id" = ANY(v_accepted_agent_only_ids)
	) AS "non_fk_dependency";

	IF v_non_fk_dependency_match_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % unexpected non-FK dependencies',
			v_non_fk_dependency_match_count;
	END IF;

	SELECT count(*)
	INTO v_ready_valid_index_count
	FROM (
		VALUES
			(
				'idx_agent_runs_chat_thread_id',
				'CREATE INDEX idx_agent_runs_chat_thread_id ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)'
			),
			(
				'idx_agent_runs_workflow_automation',
				'CREATE INDEX idx_agent_runs_workflow_automation ON public.agent_runs USING btree (workflow_automation_id) WHERE (workflow_automation_id IS NOT NULL)'
			),
			(
				'idx_agent_runs_goal',
				'CREATE INDEX idx_agent_runs_goal ON public.agent_runs USING btree (goal_id) WHERE (goal_id IS NOT NULL)'
			)
	) AS "expected_index"("name", "definition")
	INNER JOIN "pg_class" AS "index_class"
		ON "index_class"."relname" = "expected_index"."name"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
		AND "index_namespace"."nspname" = 'public'
	INNER JOIN "pg_index" AS "index_row"
		ON "index_row"."indexrelid" = "index_class"."oid"
	WHERE "index_class"."relkind" = 'i'
		AND "index_row"."indrelid" = 'public.agent_runs'::regclass
		AND "index_row"."indisready"
		AND "index_row"."indisvalid"
		AND pg_get_indexdef("index_class"."oid") = "expected_index"."definition";

	IF v_ready_valid_index_count <> 3 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % exact ready/valid indexes',
			v_ready_valid_index_count;
	END IF;

	SELECT count(*)
	INTO v_recovery_index_count
	FROM "pg_class" AS "index_class"
	INNER JOIN "pg_namespace" AS "index_namespace"
		ON "index_namespace"."oid" = "index_class"."relnamespace"
	WHERE "index_namespace"."nspname" = 'public'
		AND "index_class"."relname" = ANY(ARRAY[
			'idx_agent_runs_chat_thread_id_stage2_invalid',
			'idx_agent_runs_workflow_automation_stage2_invalid',
			'idx_agent_runs_goal_stage2_invalid'
		]);

	IF v_recovery_index_count <> 0 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % invalid-index recovery artifacts',
			v_recovery_index_count;
	END IF;

	SELECT count(*)
	INTO v_validated_constraint_count
	FROM (
		VALUES
			(
				'agent_runs_chat_thread_id_chat_threads_id_fk',
				'FOREIGN KEY (chat_thread_id) REFERENCES chat_threads(id) ON DELETE SET NULL'
			),
			(
				'agent_runs_workflow_automation_id_zero_workflow_automations_id_',
				'FOREIGN KEY (workflow_automation_id) REFERENCES zero_workflow_automations(id) ON DELETE SET NULL'
			),
			(
				'agent_runs_goal_id_thread_goals_id_fk',
				'FOREIGN KEY (goal_id) REFERENCES thread_goals(id) ON DELETE SET NULL'
			),
			(
				'agent_runs_autonomy_budget_check',
				'CHECK (autonomy_budget >= 0 AND autonomy_budget <= 10)'
			)
	) AS "expected_constraint"("name", "definition")
	INNER JOIN "pg_constraint" AS "constraint_row"
		ON "constraint_row"."conrelid" = 'public.agent_runs'::regclass
		AND "constraint_row"."conname" = "expected_constraint"."name"
	WHERE "constraint_row"."convalidated"
		AND pg_get_constraintdef("constraint_row"."oid", true) = "expected_constraint"."definition";

	IF v_validated_constraint_count <> 4 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % exact validated constraints',
			v_validated_constraint_count;
	END IF;

	SELECT count(*)
	INTO v_bridge_trigger_count
	FROM "pg_trigger" AS "trigger_row"
	INNER JOIN "pg_proc" AS "function_row"
		ON "function_row"."oid" = "trigger_row"."tgfoid"
	INNER JOIN "pg_namespace" AS "function_namespace"
		ON "function_namespace"."oid" = "function_row"."pronamespace"
	INNER JOIN "pg_language" AS "function_language"
		ON "function_language"."oid" = "function_row"."prolang"
	WHERE "trigger_row"."tgrelid" = 'public.zero_runs'::regclass
		AND "trigger_row"."tgname" = 'sync_zero_run_metadata_to_agent_runs'
		AND NOT "trigger_row"."tgisinternal"
		AND "trigger_row"."tgenabled" = 'O'
		AND "trigger_row"."tgtype" = 21
		AND "trigger_row"."tgnargs" = 0
		AND "trigger_row"."tgqual" IS NULL
		AND "trigger_row"."tgconstraint" = 0
		AND NOT "trigger_row"."tgdeferrable"
		AND NOT "trigger_row"."tginitdeferred"
		AND (
			SELECT array_agg(
				"trigger_attribute"."attname"
				ORDER BY "trigger_attribute"."attname"
			)
			FROM unnest("trigger_row"."tgattr"::smallint[])
				AS "trigger_key"("attnum")
			INNER JOIN "pg_attribute" AS "trigger_attribute"
				ON "trigger_attribute"."attrelid" = "trigger_row"."tgrelid"
				AND "trigger_attribute"."attnum" = "trigger_key"."attnum"
		) = ARRAY[
			'api_started_at',
			'autonomy_budget',
			'chat_thread_id',
			'codex_service_tier',
			'first_assistant_event_acknowledged_at',
			'goal_id',
			'model_provider',
			'model_provider_credential_scope',
			'model_provider_id',
			'selected_model',
			'selected_video_model',
			'summary',
			'trigger_brief',
			'trigger_source',
			'workflow_automation_id'
		]::name[]
		AND "function_namespace"."nspname" = 'public'
		AND "function_row"."proname" = 'sync_zero_run_metadata_to_agent_runs'
		AND "function_row"."pronargs" = 0
		AND "function_row"."prokind" = 'f'
		AND "function_row"."prorettype" = 'trigger'::regtype
		AND "function_language"."lanname" = 'plpgsql'
		AND "function_row"."provolatile" = 'v'
		AND "function_row"."proparallel" = 'u'
		AND NOT "function_row"."prosecdef"
		AND NOT "function_row"."proleakproof"
		AND md5("function_row"."prosrc") = '63665b45e2bb69f78d27ded47ef8f2d4';

	IF v_bridge_trigger_count <> 1 THEN
		RAISE EXCEPTION 'Stage 2 final validation found % exact enabled Stage 1 bridge triggers',
			v_bridge_trigger_count;
	END IF;

	RAISE NOTICE
		'Stage 2 agent-run metadata validation: agent_runs=%, zero_runs=%, paired=%, zero_only=%, invalid_sources=%, agent_only=%, agent_only_digest=%, callbacks=%, callback_runs=%, callback_digest=%, metadata_mismatches=%, inbound_fks=%, reviewed_non_fk_fields=%, fk_dependency_matches=%, non_fk_dependency_matches=%, ready_valid_indexes=%, recovery_indexes=%, validated_constraints=%, bridge_triggers=%',
		v_agent_run_count,
		v_zero_run_count,
		v_paired_count,
		v_zero_only_count,
		v_invalid_source_count,
		v_agent_only_count,
		v_agent_only_digest,
		v_callback_count,
		v_callback_run_count,
		v_callback_digest,
		v_metadata_mismatch_count,
		v_inbound_fk_count,
		v_reviewed_non_fk_count,
		v_fk_dependency_match_count,
		v_non_fk_dependency_match_count,
		v_ready_valid_index_count,
		v_recovery_index_count,
		v_validated_constraint_count,
		v_bridge_trigger_count;
END;
$$;
--> statement-breakpoint
COMMIT;
