CREATE FUNCTION "assert_org_custom_connector_oauth_mode"(
	"target_connector_id" uuid,
	"target_org_id" text
) RETURNS void
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
		"target_auth_mode" = 'oauth'
		AND "oauth_config_count" <> 1
	) OR (
		"target_auth_mode" = 'manual'
		AND "oauth_config_count" <> 0
	) THEN
		RAISE EXCEPTION
			'custom connector auth mode and OAuth config do not match'
			USING ERRCODE = '23514';
	END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "enforce_org_custom_connector_oauth_mode"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_TABLE_NAME = 'org_custom_connectors' THEN
		PERFORM "assert_org_custom_connector_oauth_mode"(NEW."id", NEW."org_id");
		RETURN NULL;
	END IF;

	IF TG_OP = 'UPDATE' AND (
		OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
		OR OLD."org_id" IS DISTINCT FROM NEW."org_id"
	) THEN
		PERFORM "assert_org_custom_connector_oauth_mode"(
			OLD."connector_id",
			OLD."org_id"
		);
	END IF;

	IF TG_OP = 'DELETE' THEN
		PERFORM "assert_org_custom_connector_oauth_mode"(
			OLD."connector_id",
			OLD."org_id"
		);
	ELSE
		PERFORM "assert_org_custom_connector_oauth_mode"(
			NEW."connector_id",
			NEW."org_id"
		);
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_org_custom_connectors_oauth_mode"
AFTER INSERT OR UPDATE ON "org_custom_connectors"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_org_custom_connector_oauth_mode"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_org_custom_connector_oauth_configs_mode"
AFTER INSERT OR UPDATE OR DELETE ON "org_custom_connector_oauth_configs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_org_custom_connector_oauth_mode"();
