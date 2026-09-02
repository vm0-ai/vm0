ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_auth_mode";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_oauth_setup";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_automatic_oauth_mcp";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_mcp";--> statement-breakpoint
UPDATE "org_custom_connectors"
SET
  "auth_mode" = 'automatic',
  "fields" = '[]'::jsonb,
  "header_injections" = '[]'::jsonb,
  "query_injections" = '[]'::jsonb
WHERE
  "auth_mode" = 'oauth'
  AND "oauth_setup" = 'automatic';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.assert_org_custom_connector_oauth_mode(target_connector_id uuid, target_org_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
	"target_auth_mode" varchar(16);
	"target_oauth_setup" varchar(16);
	"oauth_config_count" integer;
BEGIN
	SELECT connector."auth_mode", connector."oauth_setup"
	INTO "target_auth_mode", "target_oauth_setup"
	FROM "org_custom_connectors" AS connector
	WHERE connector."id" = "target_connector_id"
		AND connector."org_id" = "target_org_id";

	IF NOT FOUND THEN
		RETURN;
	END IF;

	SELECT count(*)::integer
	INTO "oauth_config_count"
	FROM "org_custom_connector_oauth_configs" AS config
	WHERE config."connector_id" = "target_connector_id"
		AND config."org_id" = "target_org_id";

	IF (
		"target_auth_mode" IN ('none', 'manual')
		AND (
			"target_oauth_setup" IS NOT NULL
			OR "oauth_config_count" <> 0
		)
	) OR (
		"target_auth_mode" = 'oauth'
		AND (
			(
				"target_oauth_setup" IS NULL
				OR "target_oauth_setup" = 'custom'
			)
			AND "oauth_config_count" <> 1
		)
	) OR (
		"target_auth_mode" = 'automatic'
		AND (
			"target_oauth_setup" <> 'automatic'
			OR "oauth_config_count" <> 0
		)
	) THEN
		RAISE EXCEPTION
			'custom connector OAuth setup and config do not match'
			USING ERRCODE = '23514';
	END IF;
END;
$$;--> statement-breakpoint
SET CONSTRAINTS "trg_org_custom_connectors_oauth_mode" IMMEDIATE;--> statement-breakpoint
SET CONSTRAINTS "trg_org_custom_connectors_oauth_mode" DEFERRED;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_auth_mode" CHECK ("org_custom_connectors"."auth_mode" IN ('none', 'manual', 'oauth', 'automatic'));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_oauth_setup" CHECK ((
          (
            "org_custom_connectors"."auth_mode" IN ('none', 'manual')
            AND "org_custom_connectors"."oauth_setup" IS NULL
          ) OR (
            "org_custom_connectors"."auth_mode" = 'oauth'
            AND (
              "org_custom_connectors"."oauth_setup" IS NULL
              OR "org_custom_connectors"."oauth_setup" = 'custom'
            )
          ) OR (
            "org_custom_connectors"."auth_mode" = 'automatic'
            AND "org_custom_connectors"."oauth_setup" = 'automatic'
          )
        ));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_automatic_oauth_mcp" CHECK ((
          "org_custom_connectors"."auth_mode" <> 'automatic'
          OR (
            "org_custom_connectors"."mcp_endpoint" IS NOT NULL
            AND "org_custom_connectors"."mcp_transport" = 'streamable-http'
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
                  "org_custom_connectors"."auth_mode" IN ('manual', 'oauth')
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
                  "org_custom_connectors"."auth_mode" IN ('none', 'automatic')
                  AND "org_custom_connectors"."fields" = '[]'::jsonb
                  AND "org_custom_connectors"."header_injections" = '[]'::jsonb
                  AND "org_custom_connectors"."query_injections" = '[]'::jsonb
                ) OR (
                  "org_custom_connectors"."auth_mode" IN ('manual', 'oauth')
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
