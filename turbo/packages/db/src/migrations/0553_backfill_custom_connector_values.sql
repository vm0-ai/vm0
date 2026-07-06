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
