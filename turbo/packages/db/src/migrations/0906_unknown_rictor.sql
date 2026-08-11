ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_skill_version_pair" CHECK ((
          ("org_custom_connectors"."skill_markdown" IS NULL AND "org_custom_connectors"."skill_storage_version_id" IS NULL)
          OR (
            "org_custom_connectors"."skill_markdown" IS NOT NULL
            AND "org_custom_connectors"."skill_storage_version_id" IS NOT NULL
          )
        ));