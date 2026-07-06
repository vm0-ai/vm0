-- Custom SQL migration file, put your code below! --
-- Block value writes and legacy writes until the bridge trigger, backfill, and
-- stale value prune have run. Do not take a migration-wide connector definition
-- lock here: old API instances can still update connectors during deployment.
-- The connector trigger below may wait for an in-flight connector write, but
-- that old write does not wait on values while holding the connector lock.
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

CREATE OR REPLACE FUNCTION lock_org_custom_connector_for_legacy_secret()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM 1
	FROM "org_custom_connectors"
	WHERE "id" = NEW."connector_id"
		AND "org_id" = NEW."org_id"
	FOR KEY SHARE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'custom connector legacy secret references missing connector'
			USING ERRCODE = '23503';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS lock_org_custom_connector_for_legacy_secret_trigger
	ON "org_custom_connector_secrets";
--> statement-breakpoint
CREATE TRIGGER lock_org_custom_connector_for_legacy_secret_trigger
BEFORE INSERT OR UPDATE OF "connector_id", "org_id" ON "org_custom_connector_secrets"
FOR EACH ROW
EXECUTE FUNCTION lock_org_custom_connector_for_legacy_secret();
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
	FOR KEY SHARE;
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
BEFORE INSERT OR UPDATE ON "org_custom_connector_values"
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

-- Temporary deployment bridge: migrations can run before every old API instance
-- stops serving traffic, so old API writes to the legacy table must still become
-- visible to the new values-only runtime. Do not sync values backward.
CREATE OR REPLACE FUNCTION sync_org_custom_connector_secret_to_value()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'DELETE' THEN
		-- Only remove the value row if it is still the legacy-synced copy.
		-- New API instances write values directly during deployment.
		DELETE FROM "org_custom_connector_values"
		WHERE "connector_id" = OLD."connector_id"
			AND "org_id" = OLD."org_id"
			AND "user_id" = OLD."user_id"
			AND "kind" = 'secret'
			AND "key" = 'secret'
			AND "encrypted_value" = OLD."encrypted_value"
			AND "updated_at" = OLD."updated_at";
		RETURN OLD;
	END IF;

	PERFORM 1
	FROM "org_custom_connectors"
	WHERE "id" = NEW."connector_id"
		AND "org_id" = NEW."org_id"
		AND org_custom_connector_value_is_declared("fields", 'secret', 'secret')
	FOR KEY SHARE;
	IF NOT FOUND THEN
		RETURN NEW;
	END IF;

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
	VALUES (
		NEW."connector_id",
		NEW."user_id",
		NEW."org_id",
		'secret',
		'secret',
		NEW."encrypted_value",
		NEW."created_at",
		NEW."updated_at"
	)
	ON CONFLICT ("connector_id", "user_id", "kind", "key") DO UPDATE
	SET
		"org_id" = EXCLUDED."org_id",
		"encrypted_value" = EXCLUDED."encrypted_value",
		"updated_at" = EXCLUDED."updated_at";
	RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS sync_org_custom_connector_secret_to_value_trigger
	ON "org_custom_connector_secrets";
--> statement-breakpoint
CREATE TRIGGER sync_org_custom_connector_secret_to_value_trigger
AFTER INSERT OR UPDATE OR DELETE ON "org_custom_connector_secrets"
FOR EACH ROW
EXECUTE FUNCTION sync_org_custom_connector_secret_to_value();
--> statement-breakpoint

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
