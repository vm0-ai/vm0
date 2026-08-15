ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_mcp";--> statement-breakpoint
ALTER TABLE "user_custom_connectors" DROP CONSTRAINT "chk_user_custom_connectors_mcp_grant";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP COLUMN "mcp_resource";--> statement-breakpoint
ALTER TABLE "user_custom_connectors" DROP COLUMN "allow_all_mcp_tools";--> statement-breakpoint
ALTER TABLE "user_custom_connectors" DROP COLUMN "mcp_tool_names";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_mcp" CHECK ((
          (
            "org_custom_connectors"."mcp_endpoint" IS NULL
            AND "org_custom_connectors"."mcp_transport" IS NULL
            AND "org_custom_connectors"."prefixes" <> '[]'::jsonb
            AND "org_custom_connectors"."prefix_templates" <> '[]'::jsonb
            AND "org_custom_connectors"."header_name" IS NOT NULL
            AND "org_custom_connectors"."header_name" <> ''
            AND "org_custom_connectors"."header_template" IS NOT NULL
            AND "org_custom_connectors"."header_template" <> ''
          ) OR (
            "org_custom_connectors"."mcp_endpoint" IS NOT NULL
            AND btrim("org_custom_connectors"."mcp_endpoint") <> ''
            AND "org_custom_connectors"."mcp_transport" IS NOT NULL
            AND "org_custom_connectors"."mcp_transport" = 'streamable-http'
            AND "org_custom_connectors"."prefixes" = '[]'::jsonb
            AND "org_custom_connectors"."prefix_templates" = '[]'::jsonb
            AND "org_custom_connectors"."header_name" IS NULL
            AND "org_custom_connectors"."header_template" IS NULL
            AND "org_custom_connectors"."permission_bundle_ref" IS NULL
          )
        ));