CREATE VIEW "built_in_model_keys" AS
SELECT
	"id",
	"vendor",
	"api_key",
	"label",
	"created_at",
	"updated_at"
FROM "vm0_api_keys";
