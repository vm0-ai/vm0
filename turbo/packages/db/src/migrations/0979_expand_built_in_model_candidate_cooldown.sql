CREATE TABLE "built_in_model_candidate_cooldown" (
	"selected_model" varchar(255) NOT NULL,
	"provider_type" varchar(100) NOT NULL,
	"upstream_model" varchar(255) NOT NULL,
	"unavailable_until" timestamp NOT NULL,
	CONSTRAINT "built_in_model_candidate_cooldown_selected_model_provider_type_upstream_model_pk" PRIMARY KEY("selected_model","provider_type","upstream_model")
);
