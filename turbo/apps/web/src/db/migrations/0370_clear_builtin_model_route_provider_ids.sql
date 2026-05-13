UPDATE "org_model_policies"
SET "model_provider_id" = NULL,
    "updated_at" = NOW()
WHERE "default_provider_type" = 'vm0'
  AND "model_provider_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD CONSTRAINT "chk_org_model_policies_builtin_route_no_provider_id" CHECK (default_provider_type <> 'vm0' OR model_provider_id IS NULL);
