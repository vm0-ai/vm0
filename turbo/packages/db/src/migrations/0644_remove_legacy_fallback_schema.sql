ALTER TABLE "device_codes" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "device_codes" ALTER COLUMN "status" SET DEFAULT 'pending'::text;--> statement-breakpoint
DROP TYPE "public"."device_code_status";--> statement-breakpoint
CREATE TYPE "public"."device_code_status" AS ENUM('pending', 'authenticated', 'denied');--> statement-breakpoint
ALTER TABLE "device_codes" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."device_code_status";--> statement-breakpoint
ALTER TABLE "device_codes" ALTER COLUMN "status" SET DATA TYPE "public"."device_code_status" USING "status"::"public"."device_code_status";--> statement-breakpoint
ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_generation" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_generation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_sequence" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "runner_state" ALTER COLUMN "heartbeat_sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "ble_session_nonce";--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "poll_token_hash";--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "poll_interval_seconds";--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "cli_token_id";--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "chat_thread_id";--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "approved_at";--> statement-breakpoint
ALTER TABLE "device_codes" DROP COLUMN "consumed_at";