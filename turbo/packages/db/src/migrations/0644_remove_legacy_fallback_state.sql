DELETE FROM "device_codes"
WHERE "purpose" <> 'cli'
   OR "status" NOT IN ('pending', 'authenticated', 'denied');
--> statement-breakpoint
UPDATE "runner_state"
SET
  "heartbeat_generation" = COALESCE("heartbeat_generation", 0),
  "heartbeat_sequence" = COALESCE("heartbeat_sequence", 0)
WHERE "heartbeat_generation" IS NULL
   OR "heartbeat_sequence" IS NULL;
