-- #29776 explicitly retires legacy authorization attempts, including pending
-- and in-flight sessions. Existing accounts and explicit intents are unchanged.
DELETE FROM "connector_oauth_states"
WHERE "account_mutation" ->> 'intent' = 'single-account';
--> statement-breakpoint
DELETE FROM "connector_oauth_device_authorization_sessions"
WHERE "account_mutation" ->> 'intent' = 'single-account';
--> statement-breakpoint
DELETE FROM "connector_external_code_sessions"
WHERE "account_mutation" ->> 'intent' = 'single-account';
