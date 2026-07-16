CREATE TABLE "connector_catalog_compatibility_evaluation" (
	"source_id" varchar(64) NOT NULL,
	"schema_version" integer NOT NULL,
	"catalog_version" varchar(255) NOT NULL,
	"integrity_digest" varchar(71) NOT NULL,
	"executable_capability_digest" varchar(71) NOT NULL,
	"evaluated_at" timestamp NOT NULL,
	"filtered_auth_methods" jsonb NOT NULL,
	CONSTRAINT "connector_catalog_compatibility_evaluation_pk" PRIMARY KEY("source_id","schema_version","catalog_version","integrity_digest","executable_capability_digest"),
	CONSTRAINT "connector_catalog_compat_eval_schema_version_positive" CHECK ("connector_catalog_compatibility_evaluation"."schema_version" > 0),
	CONSTRAINT "connector_catalog_compatibility_evaluation_digest_valid" CHECK ("connector_catalog_compatibility_evaluation"."executable_capability_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" ADD CONSTRAINT "connector_catalog_compatibility_evaluation_sync_state_fk" FOREIGN KEY ("source_id","schema_version") REFERENCES "public"."connector_catalog_sync_state"("source_id","schema_version") ON DELETE no action ON UPDATE no action;