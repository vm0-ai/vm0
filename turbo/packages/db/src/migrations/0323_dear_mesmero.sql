ALTER TYPE "public"."device_code_status" ADD VALUE 'approved' BEFORE 'expired';--> statement-breakpoint
ALTER TYPE "public"."device_code_status" ADD VALUE 'consumed' BEFORE 'expired';--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "poll_token_hash" text;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "poll_interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "cli_token_id" uuid;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "chat_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "consumed_at" timestamp;