ALTER TABLE "org_model_policies" DROP CONSTRAINT "org_model_policies_model_provider_id_model_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD CONSTRAINT "org_model_policies_model_provider_id_model_providers_id_fk" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;