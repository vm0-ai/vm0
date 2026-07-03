CREATE TABLE "org_model_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"model" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer NOT NULL,
	"default_provider_type" varchar(50) DEFAULT 'vm0' NOT NULL,
	"credential_scope" varchar(20) DEFAULT 'org' NOT NULL,
	"model_provider_id" uuid,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_model_policies_credential_scope" CHECK (credential_scope IN ('org', 'member')),
	CONSTRAINT "chk_org_model_policies_member_scope_no_provider_id" CHECK (credential_scope <> 'member' OR model_provider_id IS NULL)
);
--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD CONSTRAINT "org_model_policies_model_provider_id_model_providers_id_fk" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_model_policies_org_model" ON "org_model_policies" USING btree ("org_id","model");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_model_policies_org_sort_order" ON "org_model_policies" USING btree ("org_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_org_model_policies_enabled_sort" ON "org_model_policies" USING btree ("org_id","enabled","sort_order");--> statement-breakpoint
CREATE INDEX "idx_org_model_policies_provider" ON "org_model_policies" USING btree ("model_provider_id") WHERE model_provider_id IS NOT NULL;