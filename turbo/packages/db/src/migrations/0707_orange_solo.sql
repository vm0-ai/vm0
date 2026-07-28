ALTER TABLE "connector_catalog_compatibility_evaluation" ADD COLUMN "catalog_validation_backend_version" varchar(64);--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" ADD COLUMN "catalog_validation_build_commit_sha" varchar(40);--> statement-breakpoint
ALTER TABLE "connector_catalog_compatibility_evaluation" ADD CONSTRAINT "connector_catalog_compat_validation_authority_complete" CHECK ((
          "connector_catalog_compatibility_evaluation"."catalog_validation_backend_version" IS NULL
          AND "connector_catalog_compatibility_evaluation"."catalog_validation_build_commit_sha" IS NULL
        ) OR (
          "connector_catalog_compatibility_evaluation"."catalog_validation_backend_version" IS NOT NULL
          AND "connector_catalog_compatibility_evaluation"."catalog_validation_backend_version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
          AND (
            "connector_catalog_compatibility_evaluation"."catalog_validation_build_commit_sha" IS NULL
            OR "connector_catalog_compatibility_evaluation"."catalog_validation_build_commit_sha" ~ '^[a-f0-9]{40}$'
          )
        ));