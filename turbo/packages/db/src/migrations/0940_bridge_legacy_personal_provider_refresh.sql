-- Temporary rollout bridge for PersonalModelProviderAccounts. The legacy
-- singleton remains authoritative for the active account while source-ID-less
-- runs and API rollback remain supported. Remove these triggers together with
-- that fallback after global enablement, rollback closure, admitted-run drain,
-- and a zero-candidate legacy seeding check.
LOCK TABLE "model_providers", "secrets" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE FUNCTION "sync_active_model_provider_state_from_legacy_0940"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE "model_provider_accounts"
	SET
		"token_expires_at" = NEW."token_expires_at",
		"needs_reconnect" = NEW."needs_reconnect",
		"last_refresh_error_code" = NEW."last_refresh_error_code",
		"updated_at" = NEW."updated_at"
	WHERE "model_provider_id" = NEW."id"
		AND "is_active" = true
		AND (
			"token_expires_at",
			"needs_reconnect",
			"last_refresh_error_code",
			"updated_at"
		) IS DISTINCT FROM (
			NEW."token_expires_at",
			NEW."needs_reconnect",
			NEW."last_refresh_error_code",
			NEW."updated_at"
		);

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "model_providers_sync_active_refresh_state_0940"
AFTER UPDATE OF
	"token_expires_at",
	"needs_reconnect",
	"last_refresh_error_code",
	"updated_at"
ON "model_providers"
FOR EACH ROW
EXECUTE FUNCTION "sync_active_model_provider_state_from_legacy_0940"();
--> statement-breakpoint
CREATE FUNCTION "sync_active_model_provider_secret_from_legacy_0940"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."type" <> 'model-provider' OR NEW."connector_id" IS NOT NULL THEN
		RETURN NEW;
	END IF;

	UPDATE "model_provider_account_secrets" AS "account_secret"
	SET
		"encrypted_value" = NEW."encrypted_value",
		"updated_at" = NEW."updated_at"
	FROM "model_provider_accounts" AS "account"
	INNER JOIN "model_providers" AS "provider"
		ON "provider"."id" = "account"."model_provider_id"
	WHERE "account_secret"."model_provider_account_id" = "account"."id"
		AND "account_secret"."name" = NEW."name"
		AND "account"."is_active" = true
		AND "provider"."org_id" = NEW."org_id"
		AND "provider"."user_id" = NEW."user_id"
		AND (
			"account_secret"."encrypted_value",
			"account_secret"."updated_at"
		) IS DISTINCT FROM (
			NEW."encrypted_value",
			NEW."updated_at"
		);

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "secrets_insert_sync_active_model_provider_secret_0940"
AFTER INSERT
ON "secrets"
FOR EACH ROW
EXECUTE FUNCTION "sync_active_model_provider_secret_from_legacy_0940"();
--> statement-breakpoint
CREATE TRIGGER "secrets_update_sync_active_model_provider_secret_0940"
AFTER UPDATE OF "encrypted_value", "updated_at"
ON "secrets"
FOR EACH ROW
EXECUTE FUNCTION "sync_active_model_provider_secret_from_legacy_0940"();
--> statement-breakpoint
COMMENT ON FUNCTION "sync_active_model_provider_state_from_legacy_0940"() IS
	'Temporary PersonalModelProviderAccounts bridge; remove with the source-ID-less model-provider fallback after rollout drain.';
--> statement-breakpoint
COMMENT ON FUNCTION "sync_active_model_provider_secret_from_legacy_0940"() IS
	'Temporary PersonalModelProviderAccounts bridge; remove with the source-ID-less model-provider fallback after rollout drain.';
--> statement-breakpoint
UPDATE "model_provider_accounts" AS "account"
SET
	"token_expires_at" = "provider"."token_expires_at",
	"needs_reconnect" = "provider"."needs_reconnect",
	"last_refresh_error_code" = "provider"."last_refresh_error_code",
	"updated_at" = "provider"."updated_at"
FROM "model_providers" AS "provider"
WHERE "provider"."id" = "account"."model_provider_id"
	AND "account"."is_active" = true
	AND (
		"account"."token_expires_at",
		"account"."needs_reconnect",
		"account"."last_refresh_error_code",
		"account"."updated_at"
	) IS DISTINCT FROM (
		"provider"."token_expires_at",
		"provider"."needs_reconnect",
		"provider"."last_refresh_error_code",
		"provider"."updated_at"
	);
--> statement-breakpoint
UPDATE "model_provider_account_secrets" AS "account_secret"
SET
	"encrypted_value" = "legacy_secret"."encrypted_value",
	"updated_at" = "legacy_secret"."updated_at"
FROM "model_provider_accounts" AS "account"
INNER JOIN "model_providers" AS "provider"
	ON "provider"."id" = "account"."model_provider_id"
INNER JOIN "secrets" AS "legacy_secret"
	ON "legacy_secret"."org_id" = "provider"."org_id"
	AND "legacy_secret"."user_id" = "provider"."user_id"
	AND "legacy_secret"."type" = 'model-provider'
	AND "legacy_secret"."connector_id" IS NULL
WHERE "account_secret"."model_provider_account_id" = "account"."id"
	AND "account_secret"."name" = "legacy_secret"."name"
	AND "account"."is_active" = true
	AND (
		"account_secret"."encrypted_value",
		"account_secret"."updated_at"
	) IS DISTINCT FROM (
		"legacy_secret"."encrypted_value",
		"legacy_secret"."updated_at"
	);
