ALTER TABLE "device_codes" ADD COLUMN "purpose" varchar(32) DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "ble_session_nonce" text;