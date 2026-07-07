-- Custom SQL migration file, put your code below! --
-- Earlier drafts of this migration installed runtime triggers. They were never
-- intended as the final design; remove them if a development database applied
-- those drafts before running the one-shot migration below.
DROP FUNCTION IF EXISTS sync_org_custom_connector_secret_to_value() CASCADE;
--> statement-breakpoint
DROP FUNCTION IF EXISTS lock_org_custom_connector_for_legacy_secret() CASCADE;
--> statement-breakpoint
DROP FUNCTION IF EXISTS validate_org_custom_connector_value() CASCADE;
--> statement-breakpoint
DROP FUNCTION IF EXISTS prune_org_custom_connector_values_for_definition() CASCADE;
--> statement-breakpoint

-- Block value writes and legacy writes until the backfill and stale value prune
-- have run. Do not add runtime triggers here: the API owns runtime validation,
-- and old API instances must not gain new connector/value lock ordering during
-- deployment.
LOCK TABLE "org_custom_connector_values" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "org_custom_connector_secrets" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION org_custom_connector_value_is_declared(
	connector_fields jsonb,
	value_kind text,
	value_key text
)
RETURNS boolean
LANGUAGE sql
AS $$
	SELECT (
		connector_fields = '[]'::jsonb
		AND value_kind = 'secret'
		AND value_key = 'secret'
	)
	OR connector_fields @> jsonb_build_array(
		jsonb_build_object('kind', value_kind, 'key', value_key)
	);
$$;
--> statement-breakpoint

-- One-time legacy backfill. The deployed old API already writes this table;
-- do not add a legacy runtime bridge that introduces extra write locks.
INSERT INTO "org_custom_connector_values" (
	"connector_id",
	"user_id",
	"org_id",
	"kind",
	"key",
	"encrypted_value",
	"created_at",
	"updated_at"
)
SELECT
	legacy."connector_id",
	legacy."user_id",
	legacy."org_id",
	'secret',
	'secret',
	legacy."encrypted_value",
	legacy."created_at",
	legacy."updated_at"
FROM "org_custom_connector_secrets" legacy
INNER JOIN "org_custom_connectors" connectors
	ON connectors."id" = legacy."connector_id"
	AND connectors."org_id" = legacy."org_id"
	AND org_custom_connector_value_is_declared(
		connectors."fields",
		'secret',
		'secret'
	)
ON CONFLICT ("connector_id", "user_id", "kind", "key") DO NOTHING;
--> statement-breakpoint

DELETE FROM "org_custom_connector_values" stored_values
USING "org_custom_connectors" connectors
WHERE connectors."id" = stored_values."connector_id"
	AND connectors."org_id" = stored_values."org_id"
	AND NOT org_custom_connector_value_is_declared(
		connectors."fields",
		stored_values."kind",
		stored_values."key"
	);
--> statement-breakpoint

DROP FUNCTION org_custom_connector_value_is_declared(jsonb, text, text);
