ALTER TABLE "chat_threads" ADD COLUMN "model_provider_type" varchar(50);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "model_provider_credential_scope" varchar(20);--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "model_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "model_provider_credential_scope" varchar(20);