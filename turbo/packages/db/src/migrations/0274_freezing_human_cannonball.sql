ALTER TABLE "chat_threads" ADD COLUMN "model_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "selected_model" varchar(255);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_model_provider_id_model_providers_id_fk" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;