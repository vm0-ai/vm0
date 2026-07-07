-- Custom SQL migration file, put your code below! --
-- Block value writes and legacy writes until the backfill and stale value prune
-- have run. Do not take a migration-wide connector definition lock here: old
-- API instances can still update connectors during deployment.
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

CREATE OR REPLACE FUNCTION validate_org_custom_connector_value()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM 1
	FROM "org_custom_connectors"
	WHERE "id" = NEW."connector_id"
		AND "org_id" = NEW."org_id"
		AND org_custom_connector_value_is_declared("fields", NEW."kind", NEW."key")
	-- Use FOR SHARE so ordinary definition updates cannot race this validation.
	FOR SHARE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'custom connector value references undeclared field'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS validate_org_custom_connector_value_trigger
	ON "org_custom_connector_values";
--> statement-breakpoint
CREATE TRIGGER validate_org_custom_connector_value_trigger
-- App writes use INSERT ... ON CONFLICT DO UPDATE. Validate on INSERT so the
-- connector row is locked before any conflicting value row is locked; only
-- revalidate UPDATEs that move the value to a different connector or field.
BEFORE INSERT OR UPDATE OF "connector_id", "org_id", "kind", "key"
ON "org_custom_connector_values"
FOR EACH ROW
EXECUTE FUNCTION validate_org_custom_connector_value();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prune_org_custom_connector_values_for_definition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	DELETE FROM "org_custom_connector_values"
	WHERE "connector_id" = NEW."id"
		AND (
			"org_id" <> NEW."org_id"
			OR NOT org_custom_connector_value_is_declared(
				NEW."fields",
				"kind",
				"key"
			)
		);

	RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS prune_org_custom_connector_values_for_definition_trigger
	ON "org_custom_connectors";
--> statement-breakpoint
CREATE TRIGGER prune_org_custom_connector_values_for_definition_trigger
AFTER UPDATE OF "org_id", "fields" ON "org_custom_connectors"
FOR EACH ROW
EXECUTE FUNCTION prune_org_custom_connector_values_for_definition();
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
