-- Custom SQL migration file, put your code below! --
-- Block value writes and legacy writes until the bridge trigger, backfill, and
-- stale value prune have run. Do not lock connector definitions here: API
-- definition updates touch org_custom_connectors before pruning values, while
-- connector deletes touch values before org_custom_connectors. Locking the
-- connector definition table would introduce a deployment-time deadlock window.
LOCK TABLE "org_custom_connector_values" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "org_custom_connector_secrets" IN SHARE ROW EXCLUSIVE MODE;
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
		AND (
			"fields" = '[]'::jsonb
			OR "fields" @> '[{"kind":"secret","key":"secret"}]'::jsonb
		)
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
	AND (
		connectors."fields" = '[]'::jsonb
		OR connectors."fields" @> '[{"kind":"secret","key":"secret"}]'::jsonb
	)
ON CONFLICT ("connector_id", "user_id", "kind", "key") DO NOTHING;
--> statement-breakpoint

DELETE FROM "org_custom_connector_values" stored_values
USING "org_custom_connectors" connectors
WHERE connectors."id" = stored_values."connector_id"
	AND connectors."org_id" = stored_values."org_id"
	AND connectors."fields" <> '[]'::jsonb
	AND NOT (
		connectors."fields" @> jsonb_build_array(
			jsonb_build_object('kind', stored_values."kind", 'key', stored_values."key")
		)
	);
