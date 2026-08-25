-- Serialize the preflight and cleanup with every authorization-state
-- transition. The generated ALTER statements need this lock mode later in the
-- same transaction, so acquire all three locks before observing legacy rows.
LOCK TABLE
	"connector_oauth_states",
	"connector_oauth_device_authorization_sessions",
	"connector_external_code_sessions"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
	"oauth_blocker_count" bigint;
	"device_blocker_count" bigint;
	"external_code_blocker_count" bigint;
BEGIN
	SELECT count(*)
	INTO "oauth_blocker_count"
	FROM "connector_oauth_states"
	WHERE "account_mutation" IS NULL
		AND "consumed_at" IS NULL
		AND "expires_at" > CURRENT_TIMESTAMP;

	SELECT count(*)
	INTO "device_blocker_count"
	FROM "connector_oauth_device_authorization_sessions"
	WHERE "account_mutation" IS NULL
		AND (
			"status" = 'polling'
			OR (
				"status" = 'awaiting_user_authorization'
				AND "expires_at" >= CURRENT_TIMESTAMP
			)
		);

	SELECT count(*)
	INTO "external_code_blocker_count"
	FROM "connector_external_code_sessions"
	WHERE "account_mutation" IS NULL
		AND (
			"status" = 'completing'
			OR (
				"status" = 'pending'
				AND "expires_at" >= CURRENT_TIMESTAMP
			)
		);

	IF "oauth_blocker_count" > 0
		OR "device_blocker_count" > 0
		OR "external_code_blocker_count" > 0
	THEN
		RAISE EXCEPTION
			'Connector authorization account mutation contraction blocked: oauth=%, device=%, external_code=%',
			"oauth_blocker_count",
			"device_blocker_count",
			"external_code_blocker_count";
	END IF;
END;
$$;--> statement-breakpoint

DELETE FROM "connector_oauth_states"
WHERE "account_mutation" IS NULL;--> statement-breakpoint
DELETE FROM "connector_oauth_device_authorization_sessions"
WHERE "account_mutation" IS NULL;--> statement-breakpoint
DELETE FROM "connector_external_code_sessions"
WHERE "account_mutation" IS NULL;--> statement-breakpoint

ALTER TABLE "connector_external_code_sessions" ALTER COLUMN "account_mutation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ALTER COLUMN "account_mutation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ALTER COLUMN "account_mutation" SET NOT NULL;
