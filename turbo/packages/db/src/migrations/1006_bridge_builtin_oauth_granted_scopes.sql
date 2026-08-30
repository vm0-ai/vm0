-- Remove this bridge in #29468 after old API write and rollback windows close.
-- It prevents an old built-in reconnect from retaining grants for the prior token.
CREATE FUNCTION "clear_builtin_oauth_granted_scopes_1006"()
RETURNS trigger AS $$
BEGIN
	NEW."oauth_granted_scopes" := NULL;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "connectors_clear_builtin_oauth_granted_scopes_1006"
BEFORE UPDATE OF "oauth_scopes" ON "connectors"
FOR EACH ROW
WHEN (NEW."connector_slug" IS NOT NULL)
EXECUTE FUNCTION "clear_builtin_oauth_granted_scopes_1006"();
