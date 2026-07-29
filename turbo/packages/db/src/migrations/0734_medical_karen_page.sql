CREATE TABLE "model_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"secret_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider_surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"protocol" varchar(32) NOT NULL,
	"api_base_url" text NOT NULL,
	"auth_header_name" varchar(128) NOT NULL,
	"auth_header_template" text NOT NULL,
	"model_mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_model_provider_surfaces_protocol" CHECK ("model_provider_surfaces"."protocol" IN ('anthropic-messages', 'openai-responses'))
);
--> statement-breakpoint
ALTER TABLE "org_model_policies" DROP CONSTRAINT "chk_org_model_policies_member_scope_no_provider_id";--> statement-breakpoint
ALTER TABLE "org_model_policies" DROP CONSTRAINT "chk_org_model_policies_builtin_route_no_provider_id";--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD COLUMN "model_provider_surface_id" uuid;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD CONSTRAINT "model_provider_connections_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_surfaces" ADD CONSTRAINT "model_provider_surfaces_connection_id_model_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_provider_connections_org" ON "model_provider_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_provider_connections_secret" ON "model_provider_connections" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "idx_model_provider_surfaces_connection" ON "model_provider_surfaces" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_provider_surfaces_connection_protocol" ON "model_provider_surfaces" USING btree ("connection_id","protocol");--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD CONSTRAINT "org_model_policies_model_provider_surface_id_model_provider_surfaces_id_fk" FOREIGN KEY ("model_provider_surface_id") REFERENCES "public"."model_provider_surfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_model_policies_surface" ON "org_model_policies" USING btree ("model_provider_surface_id") WHERE model_provider_surface_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD CONSTRAINT "chk_org_model_policies_one_route_id" CHECK (model_provider_id IS NULL OR model_provider_surface_id IS NULL);--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD CONSTRAINT "chk_org_model_policies_member_scope_no_provider_id" CHECK (credential_scope <> 'member' OR (model_provider_id IS NULL AND model_provider_surface_id IS NULL));--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD CONSTRAINT "chk_org_model_policies_builtin_route_no_provider_id" CHECK (default_provider_type <> 'vm0' OR (model_provider_id IS NULL AND model_provider_surface_id IS NULL));