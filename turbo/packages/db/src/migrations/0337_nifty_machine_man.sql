ALTER TABLE "model_providers" ADD COLUMN "token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "needs_reconnect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "last_refresh_error_code" varchar(64);