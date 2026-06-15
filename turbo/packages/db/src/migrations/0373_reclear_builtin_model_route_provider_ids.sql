UPDATE "org_model_policies"
SET "model_provider_id" = NULL,
    "updated_at" = NOW()
WHERE "default_provider_type" = 'vm0'
  AND "model_provider_id" IS NOT NULL;
