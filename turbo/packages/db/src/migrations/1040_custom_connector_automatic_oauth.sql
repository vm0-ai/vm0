CREATE TABLE "custom_connector_account_oauth_bindings" (
	"connector_account_id" uuid PRIMARY KEY NOT NULL,
	"custom_connector_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"resource" text NOT NULL,
	"resource_metadata_url" text,
	"token_endpoint" text NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"token_endpoint_auth_method" varchar(32) NOT NULL,
	"registration_method" varchar(8) NOT NULL,
	"dcr_registration_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_custom_connector_account_oauth_binding_identity" CHECK ((
          btrim("custom_connector_account_oauth_bindings"."issuer") <> ''
          AND btrim("custom_connector_account_oauth_bindings"."resource") <> ''
          AND btrim("custom_connector_account_oauth_bindings"."token_endpoint") <> ''
          AND btrim("custom_connector_account_oauth_bindings"."client_id") <> ''
          AND (
            "custom_connector_account_oauth_bindings"."resource_metadata_url" IS NULL
            OR btrim("custom_connector_account_oauth_bindings"."resource_metadata_url") <> ''
          )
        )),
	CONSTRAINT "chk_custom_connector_account_oauth_binding_token_auth_method" CHECK ("custom_connector_account_oauth_bindings"."token_endpoint_auth_method" IN (
          'none',
          'client_secret_basic',
          'client_secret_post'
        )),
	CONSTRAINT "chk_custom_connector_account_oauth_binding_registration" CHECK ((
          (
            "custom_connector_account_oauth_bindings"."registration_method" = 'cimd'
            AND "custom_connector_account_oauth_bindings"."dcr_registration_id" IS NULL
            AND "custom_connector_account_oauth_bindings"."token_endpoint_auth_method" = 'none'
          ) OR (
            "custom_connector_account_oauth_bindings"."registration_method" = 'dcr'
            AND "custom_connector_account_oauth_bindings"."dcr_registration_id" IS NOT NULL
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "org_custom_connector_dcr_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"custom_connector_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"encrypted_client_secret" text,
	"token_endpoint_auth_method" varchar(32) NOT NULL,
	"registered_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"redirect_uri" text NOT NULL,
	"issued_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_org_custom_connector_dcr_registration_id_connector" UNIQUE("id","custom_connector_id"),
	CONSTRAINT "uq_org_custom_connector_dcr_registration_issuer" UNIQUE("custom_connector_id","issuer"),
	CONSTRAINT "chk_org_custom_connector_dcr_registration_identity" CHECK ((
          btrim("org_custom_connector_dcr_registrations"."issuer") <> ''
          AND btrim("org_custom_connector_dcr_registrations"."client_id") <> ''
          AND btrim("org_custom_connector_dcr_registrations"."redirect_uri") <> ''
        )),
	CONSTRAINT "chk_org_custom_connector_dcr_registration_token_auth_method" CHECK ((
          (
            "org_custom_connector_dcr_registrations"."token_endpoint_auth_method" = 'none'
            AND "org_custom_connector_dcr_registrations"."encrypted_client_secret" IS NULL
          ) OR (
            "org_custom_connector_dcr_registrations"."token_endpoint_auth_method" IN (
              'client_secret_basic',
              'client_secret_post'
            )
            AND "org_custom_connector_dcr_registrations"."encrypted_client_secret" IS NOT NULL
          )
        )),
	CONSTRAINT "chk_org_custom_connector_dcr_registration_expiry" CHECK ("org_custom_connector_dcr_registrations"."expires_at" IS NULL OR "org_custom_connector_dcr_registrations"."expires_at" > "org_custom_connector_dcr_registrations"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "oauth_setup" varchar(16);--> statement-breakpoint
ALTER TABLE "custom_connector_account_oauth_bindings" ADD CONSTRAINT "fk_custom_connector_account_oauth_bindings_account" FOREIGN KEY ("connector_account_id","custom_connector_id") REFERENCES "public"."connectors"("id","custom_connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_connector_account_oauth_bindings" ADD CONSTRAINT "fk_custom_connector_account_oauth_bindings_dcr_registration" FOREIGN KEY ("dcr_registration_id","custom_connector_id") REFERENCES "public"."org_custom_connector_dcr_registrations"("id","custom_connector_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_custom_connector_dcr_registrations" ADD CONSTRAINT "fk_org_custom_connector_dcr_registrations_connector" FOREIGN KEY ("custom_connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_custom_connector_account_oauth_bindings_dcr" ON "custom_connector_account_oauth_bindings" USING btree ("dcr_registration_id");--> statement-breakpoint
CREATE INDEX "idx_org_custom_connector_dcr_registrations_org" ON "org_custom_connector_dcr_registrations" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_oauth_setup" CHECK ((
          (
            "org_custom_connectors"."auth_mode" = 'manual'
            AND "org_custom_connectors"."oauth_setup" IS NULL
          ) OR (
            "org_custom_connectors"."auth_mode" = 'oauth'
            AND (
              "org_custom_connectors"."oauth_setup" IS NULL
              OR "org_custom_connectors"."oauth_setup" IN ('custom', 'automatic')
            )
          )
        ));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_automatic_oauth_mcp" CHECK ((
          "org_custom_connectors"."oauth_setup" IS DISTINCT FROM 'automatic'
          OR (
            "org_custom_connectors"."mcp_endpoint" IS NOT NULL
            AND "org_custom_connectors"."mcp_transport" = 'streamable-http'
          )
        ));--> statement-breakpoint
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
		"target_auth_mode" = 'manual'
		AND (
			"target_oauth_setup" IS NOT NULL
			OR "oauth_config_count" <> 0
		)
	) OR (
		"target_auth_mode" = 'oauth'
		AND (
			(
				(
					"target_oauth_setup" IS NULL
					OR "target_oauth_setup" = 'custom'
				)
				AND "oauth_config_count" <> 1
			) OR (
				"target_oauth_setup" = 'automatic'
				AND "oauth_config_count" <> 0
			)
		)
	) THEN
		RAISE EXCEPTION
			'custom connector OAuth setup and config do not match'
			USING ERRCODE = '23514';
	END IF;
END;
$$;
