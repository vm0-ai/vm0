INSERT INTO "connectors" (
	"custom_connector_id",
	"auth_method",
	"storage_version",
	"user_id",
	"org_id"
)
SELECT
	"credential_identity"."connector_id",
	'manual',
	"definition"."storage_version",
	"credential_identity"."user_id",
	"credential_identity"."org_id"
FROM (
	SELECT "connector_id", "user_id", "org_id"
	FROM "org_custom_connector_values"
	UNION
	SELECT "connector_id", "user_id", "org_id"
	FROM "org_custom_connector_secrets"
) AS "credential_identity"
INNER JOIN "org_custom_connectors" AS "definition"
	ON "definition"."id" = "credential_identity"."connector_id"
	AND "definition"."org_id" = "credential_identity"."org_id"
	AND "definition"."auth_mode" = 'manual'
ON CONFLICT ("org_id", "user_id", "custom_connector_id")
	WHERE "custom_connector_id" IS NOT NULL
	DO NOTHING;--> statement-breakpoint
CREATE FUNCTION "ensure_custom_manual_connector_parent_v1"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO "connectors" (
		"custom_connector_id",
		"auth_method",
		"storage_version",
		"user_id",
		"org_id"
	)
	SELECT
		NEW."connector_id",
		'manual',
		1,
		NEW."user_id",
		NEW."org_id"
	FROM "org_custom_connectors" AS "definition"
	WHERE "definition"."id" = NEW."connector_id"
		AND "definition"."org_id" = NEW."org_id"
		AND "definition"."auth_mode" = 'manual'
		AND "definition"."storage_version" = 1
	ON CONFLICT ("org_id", "user_id", "custom_connector_id")
		WHERE "custom_connector_id" IS NOT NULL
		DO NOTHING;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "org_custom_connector_values_ensure_parent_v1"
AFTER INSERT OR UPDATE ON "org_custom_connector_values"
FOR EACH ROW
EXECUTE FUNCTION "ensure_custom_manual_connector_parent_v1"();
