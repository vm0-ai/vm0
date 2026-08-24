INSERT INTO "built_in_model_candidate_cooldown" (
	"selected_model",
	"provider_type",
	"upstream_model",
	"unavailable_until"
)
SELECT
	"selected_model",
	"provider_type",
	"upstream_model",
	"unavailable_until"
FROM "managed_model_candidate_cooldown"
ON CONFLICT ("selected_model", "provider_type", "upstream_model")
DO UPDATE SET
	"unavailable_until" = GREATEST(
		"built_in_model_candidate_cooldown"."unavailable_until",
		EXCLUDED."unavailable_until"
	);
