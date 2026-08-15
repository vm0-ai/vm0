-- The previous API release removed every executable dependency on these
-- tables. Lock its delete bridge and both sources as one contraction boundary.
LOCK TABLE
	"connectors",
	"org_custom_connector_secrets",
	"org_custom_connector_values"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
	bridge_trigger_count integer;
	legacy_table_trigger_count integer;
	routine_references text[];
BEGIN
	SELECT COUNT(*)
	INTO bridge_trigger_count
	FROM "pg_trigger" AS "catalog_trigger"
	INNER JOIN "pg_proc" AS "routine"
		ON "routine"."oid" = "catalog_trigger"."tgfoid"
	INNER JOIN "pg_namespace" AS "namespace"
		ON "namespace"."oid" = "routine"."pronamespace"
	WHERE "catalog_trigger"."tgrelid" = 'public.connectors'::regclass
		AND "catalog_trigger"."tgname" = 'connectors_delete_legacy_custom_credentials_0911'
		AND NOT "catalog_trigger"."tgisinternal"
		AND "catalog_trigger"."tgenabled" = 'O'
		AND "namespace"."nspname" = 'public'
		AND "routine"."proname" = 'delete_legacy_custom_credentials_0911'
		AND "routine"."prokind" = 'f'
		AND "routine"."prorettype" = 'trigger'::regtype
		AND pg_get_function_identity_arguments("routine"."oid") = '';

	IF bridge_trigger_count <> 1 THEN
		RAISE EXCEPTION
			'Expected one enabled legacy Custom credential delete bridge, found %',
			bridge_trigger_count;
	END IF;

	SELECT COUNT(*)
	INTO legacy_table_trigger_count
	FROM "pg_trigger"
	WHERE "tgrelid" IN (
			'public.org_custom_connector_secrets'::regclass,
			'public.org_custom_connector_values'::regclass
		)
		AND NOT "tgisinternal";

	IF legacy_table_trigger_count <> 0 THEN
		RAISE EXCEPTION
			'Expected no user triggers on legacy Custom credential tables, found %',
			legacy_table_trigger_count;
	END IF;

	WITH "stored_routines" AS MATERIALIZED (
		SELECT
			"namespace"."nspname" AS "schema_name",
			"routine"."proname" AS "routine_name",
			pg_get_function_identity_arguments("routine"."oid") AS "identity_arguments",
			pg_get_functiondef("routine"."oid") AS "definition"
		FROM "pg_proc" AS "routine"
		INNER JOIN "pg_namespace" AS "namespace"
			ON "namespace"."oid" = "routine"."pronamespace"
		WHERE "routine"."prokind" IN ('f', 'p')
			AND "namespace"."nspname" NOT IN ('pg_catalog', 'information_schema')
	)
	SELECT array_agg(
		format(
			'%I.%I(%s)',
			"schema_name",
			"routine_name",
			"identity_arguments"
		)
		ORDER BY "schema_name", "routine_name", "identity_arguments"
	)
	INTO routine_references
	FROM "stored_routines"
	WHERE "definition" ILIKE '%org_custom_connector_secrets%'
		OR "definition" ILIKE '%org_custom_connector_values%';

	IF routine_references IS DISTINCT FROM ARRAY[
		'public.delete_legacy_custom_credentials_0911()'
	]::text[] THEN
		RAISE EXCEPTION
			'Unexpected stored routines reference legacy Custom credential tables: %',
			routine_references;
	END IF;
END;
$$;--> statement-breakpoint

DROP TRIGGER "connectors_delete_legacy_custom_credentials_0911"
ON "connectors";--> statement-breakpoint
DROP FUNCTION "delete_legacy_custom_credentials_0911"();--> statement-breakpoint
DROP TABLE "org_custom_connector_secrets";--> statement-breakpoint
DROP TABLE "org_custom_connector_values";
