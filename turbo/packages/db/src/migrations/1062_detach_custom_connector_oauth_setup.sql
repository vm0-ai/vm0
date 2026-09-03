CREATE OR REPLACE FUNCTION public.assert_org_custom_connector_oauth_mode(target_connector_id uuid, target_org_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
	"target_auth_mode" varchar(16);
	"oauth_config_count" integer;
BEGIN
	SELECT connector."auth_mode"
	INTO "target_auth_mode"
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
		"target_auth_mode" IN ('none', 'manual', 'automatic')
		AND "oauth_config_count" <> 0
	) OR (
		"target_auth_mode" = 'oauth'
		AND "oauth_config_count" <> 1
	) THEN
		RAISE EXCEPTION
			'custom connector OAuth mode and config do not match'
			USING ERRCODE = '23514';
	END IF;
END;
$$;
