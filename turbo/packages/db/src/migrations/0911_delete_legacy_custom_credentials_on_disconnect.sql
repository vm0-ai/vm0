CREATE FUNCTION "delete_legacy_custom_credentials_0911"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."custom_connector_id" IS NOT NULL THEN
		DELETE FROM "org_custom_connector_values"
		WHERE "connector_id" = OLD."custom_connector_id"
			AND "org_id" = OLD."org_id"
			AND "user_id" = OLD."user_id";

		DELETE FROM "org_custom_connector_secrets"
		WHERE "connector_id" = OLD."custom_connector_id"
			AND "org_id" = OLD."org_id"
			AND "user_id" = OLD."user_id";
	END IF;

	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "connectors_delete_legacy_custom_credentials_0911"
AFTER DELETE ON "connectors"
FOR EACH ROW
EXECUTE FUNCTION "delete_legacy_custom_credentials_0911"();
