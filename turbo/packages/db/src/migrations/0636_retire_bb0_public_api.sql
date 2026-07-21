DELETE FROM "device_codes"
WHERE
  "purpose" = 'bb0'
  OR "status" IN ('approved', 'consumed', 'expired');
--> statement-breakpoint
DELETE FROM "cli_tokens"
WHERE "name" = 'bb0 device';
--> statement-breakpoint
UPDATE "user_feature_switches"
SET
  "switches" = "switches" - 'apiKeys',
  "updated_at" = NOW()
WHERE "switches" ? 'apiKeys';
