-- Custom SQL migration file, put your code below! --
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
ON CONFLICT ("connector_id", "user_id", "kind", "key") DO NOTHING;
--> statement-breakpoint

-- Temporary rollout bridge: old API instances may still write the legacy table,
-- while new API instances use org_custom_connector_values as the runtime source
-- of truth. Sync legacy writes forward to values. Do not sync values backward:
-- current main already reads values, and bidirectional row triggers can deadlock
-- when old and new API instances write the same connector concurrently.
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
		DELETE FROM "org_custom_connector_values"
		WHERE "connector_id" = OLD."connector_id"
			AND "user_id" = OLD."user_id"
			AND "kind" = 'secret'
			AND "key" = 'secret';
		RETURN OLD;
	END IF;

	PERFORM 1
	FROM "org_custom_connectors"
	WHERE "id" = NEW."connector_id"
		AND "org_id" = NEW."org_id"
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
