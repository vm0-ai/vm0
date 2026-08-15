DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "org_custom_connectors"
    WHERE NOT (
      jsonb_typeof("prefix_templates") = 'array'
      AND jsonb_typeof("fields") = 'array'
      AND jsonb_typeof("header_injections") = 'array'
      AND jsonb_typeof("query_injections") = 'array'
      AND (
        (
          "mcp_endpoint" IS NULL
          AND "mcp_transport" IS NULL
          AND "prefix_templates" <> '[]'::jsonb
          AND (
            "header_injections" <> '[]'::jsonb
            OR "query_injections" <> '[]'::jsonb
          )
        ) OR (
          "mcp_endpoint" IS NOT NULL
          AND btrim("mcp_endpoint") <> ''
          AND "mcp_transport" IS NOT NULL
          AND "mcp_transport" = 'streamable-http'
          AND "prefix_templates" = '[]'::jsonb
          AND (
            "header_injections" <> '[]'::jsonb
            OR "query_injections" <> '[]'::jsonb
          )
          AND "permission_bundle_ref" IS NULL
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Invalid canonical Custom Connector protocol state before reader preparation';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_mcp";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ALTER COLUMN "prefixes" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_mcp" CHECK ((
          jsonb_typeof("org_custom_connectors"."prefix_templates") = 'array'
          AND jsonb_typeof("org_custom_connectors"."fields") = 'array'
          AND jsonb_typeof("org_custom_connectors"."header_injections") = 'array'
          AND jsonb_typeof("org_custom_connectors"."query_injections") = 'array'
          AND (
            (
              "org_custom_connectors"."mcp_endpoint" IS NULL
              AND "org_custom_connectors"."mcp_transport" IS NULL
              AND "org_custom_connectors"."prefix_templates" <> '[]'::jsonb
              AND (
                "org_custom_connectors"."header_injections" <> '[]'::jsonb
                OR "org_custom_connectors"."query_injections" <> '[]'::jsonb
              )
            ) OR (
              "org_custom_connectors"."mcp_endpoint" IS NOT NULL
              AND btrim("org_custom_connectors"."mcp_endpoint") <> ''
              AND "org_custom_connectors"."mcp_transport" IS NOT NULL
              AND "org_custom_connectors"."mcp_transport" = 'streamable-http'
              AND "org_custom_connectors"."prefix_templates" = '[]'::jsonb
              AND (
                "org_custom_connectors"."header_injections" <> '[]'::jsonb
                OR "org_custom_connectors"."query_injections" <> '[]'::jsonb
              )
              AND "org_custom_connectors"."permission_bundle_ref" IS NULL
            )
          )
        ));--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'org_custom_connectors'
      AND "column_name" = 'prefixes'
      AND "column_default" = '''[]''::jsonb'
  ) THEN
    RAISE EXCEPTION 'Custom Connector legacy prefixes default is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'chk_org_custom_connectors_mcp'
      AND "conrelid" = 'org_custom_connectors'::regclass
      AND "convalidated"
      AND strpos(pg_get_constraintdef("oid"), 'prefix_templates') > 0
      AND strpos(pg_get_constraintdef("oid"), 'fields') > 0
      AND strpos(pg_get_constraintdef("oid"), 'header_injections') > 0
      AND strpos(pg_get_constraintdef("oid"), 'query_injections') > 0
      AND strpos(pg_get_constraintdef("oid"), 'prefixes') = 0
      AND strpos(pg_get_constraintdef("oid"), 'header_name') = 0
      AND strpos(pg_get_constraintdef("oid"), 'header_template') = 0
  ) THEN
    RAISE EXCEPTION 'Canonical Custom Connector protocol constraint is missing or invalid';
  END IF;
END
$$;
