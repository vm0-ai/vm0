DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "org_custom_connectors"
    WHERE "mcp_endpoint" IS NOT NULL
       OR "mcp_transport" IS NOT NULL
       OR "mcp_resource" IS NOT NULL
       OR "prefixes" = '[]'::jsonb
       OR "prefix_templates" = '[]'::jsonb
       OR "header_name" IS NULL
       OR "header_name" = ''
       OR "header_template" IS NULL
       OR "header_template" = ''
  ) THEN
    RAISE EXCEPTION 'Unexpected Custom Connector definition state before MCP reader preparation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "user_custom_connectors"
    WHERE "allow_all_mcp_tools"
       OR cardinality("mcp_tool_names") <> 0
  ) THEN
    RAISE EXCEPTION 'Unexpected Custom Connector MCP tool-grant state before reader preparation';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_mcp";--> statement-breakpoint
ALTER TABLE "user_custom_connectors" DROP CONSTRAINT "chk_user_custom_connectors_mcp_grant";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ALTER COLUMN "header_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ALTER COLUMN "header_template" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_mcp" CHECK ((
          "org_custom_connectors"."mcp_resource" IS NULL
          AND (
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
          )
        ));--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD CONSTRAINT "chk_user_custom_connectors_mcp_grant" CHECK (NOT "user_custom_connectors"."allow_all_mcp_tools" AND cardinality("user_custom_connectors"."mcp_tool_names") = 0);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'org_custom_connectors'
      AND "column_name" IN ('header_name', 'header_template')
      AND "is_nullable" <> 'YES'
  ) THEN
    RAISE EXCEPTION 'Custom Connector MCP header columns remain non-nullable';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_constraint"
    WHERE "conname" IN (
      'chk_org_custom_connectors_mcp',
      'chk_user_custom_connectors_mcp_grant'
    )
      AND "convalidated"
  ) <> 2 THEN
    RAISE EXCEPTION 'Custom Connector MCP reader constraints are missing or invalid';
  END IF;
END
$$;
