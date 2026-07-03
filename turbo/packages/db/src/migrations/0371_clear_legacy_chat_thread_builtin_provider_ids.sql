UPDATE "zero_runs"
SET "model_provider_id" = NULL
WHERE "model_provider" = 'vm0'
  AND "model_provider_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "chat_threads"
SET "model_provider_id" = NULL
WHERE "model_provider_type" = 'vm0'
  AND "model_provider_id" IS NOT NULL;
