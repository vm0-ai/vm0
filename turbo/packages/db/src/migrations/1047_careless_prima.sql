ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_auth_mode";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_oauth_setup";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_mcp";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_auth_mode" CHECK ("org_custom_connectors"."auth_mode" IN ('none', 'manual', 'oauth'));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_oauth_setup" CHECK ((
          (
            "org_custom_connectors"."auth_mode" IN ('none', 'manual')
            AND "org_custom_connectors"."oauth_setup" IS NULL
          ) OR (
            "org_custom_connectors"."auth_mode" = 'oauth'
            AND (
              "org_custom_connectors"."oauth_setup" IS NULL
              OR "org_custom_connectors"."oauth_setup" IN ('custom', 'automatic')
            )
          )
        ));--> statement-breakpoint
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
                (
                  "org_custom_connectors"."auth_mode" = 'none'
                  AND NOT jsonb_path_exists(
                    "org_custom_connectors"."fields",
                    '$[*] ? (@.kind == "secret")'
                  )
                  AND "org_custom_connectors"."header_injections" = '[]'::jsonb
                  AND "org_custom_connectors"."query_injections" = '[]'::jsonb
                ) OR (
                  "org_custom_connectors"."auth_mode" <> 'none'
                  AND (
                    "org_custom_connectors"."header_injections" <> '[]'::jsonb
                    OR "org_custom_connectors"."query_injections" <> '[]'::jsonb
                  )
                )
              )
            ) OR (
              "org_custom_connectors"."mcp_endpoint" IS NOT NULL
              AND btrim("org_custom_connectors"."mcp_endpoint") <> ''
              AND "org_custom_connectors"."mcp_transport" IS NOT NULL
              AND "org_custom_connectors"."mcp_transport" = 'streamable-http'
              AND "org_custom_connectors"."prefix_templates" = '[]'::jsonb
              AND (
                (
                  "org_custom_connectors"."auth_mode" = 'none'
                  AND "org_custom_connectors"."fields" = '[]'::jsonb
                  AND "org_custom_connectors"."header_injections" = '[]'::jsonb
                  AND "org_custom_connectors"."query_injections" = '[]'::jsonb
                ) OR (
                  "org_custom_connectors"."auth_mode" <> 'none'
                  AND (
                    "org_custom_connectors"."header_injections" <> '[]'::jsonb
                    OR "org_custom_connectors"."query_injections" <> '[]'::jsonb
                  )
                )
              )
              AND "org_custom_connectors"."permission_bundle_ref" IS NULL
            )
          )
        ));