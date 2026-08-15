ALTER TABLE "connector_oauth_states" ADD COLUMN "storage_version" bigint;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "storage_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "chk_connector_oauth_states_custom_storage_version" CHECK ((
          "connector_oauth_states"."custom_connector_id" IS NULL
          AND "connector_oauth_states"."storage_version" IS NULL
        ) OR (
          "connector_oauth_states"."custom_connector_id" IS NOT NULL
          AND (
            "connector_oauth_states"."storage_version" IS NULL
            OR "connector_oauth_states"."storage_version" > 0
          )
        ));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_storage_version_positive" CHECK ("org_custom_connectors"."storage_version" > 0);