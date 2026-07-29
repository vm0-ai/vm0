CREATE TABLE "org_custom_connector_oauth_configs" (
	"connector_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_adapter" varchar(32) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"authorization_url" text NOT NULL,
	"token_url" text NOT NULL,
	"token_endpoint_auth_method" varchar(32) NOT NULL,
	"pkce_method" varchar(8) NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"authorization_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_custom_connector_oauth_configs_provider_adapter" CHECK ("org_custom_connector_oauth_configs"."provider_adapter" IN ('standard', 'feishu')),
	CONSTRAINT "chk_org_custom_connector_oauth_configs_pkce_method" CHECK ("org_custom_connector_oauth_configs"."pkce_method" IN ('none', 'S256')),
	CONSTRAINT "chk_org_custom_connector_oauth_configs_token_auth_method" CHECK ("org_custom_connector_oauth_configs"."token_endpoint_auth_method" IN (
          'client_secret_basic',
          'client_secret_post'
        ))
);
--> statement-breakpoint
ALTER TABLE "org_custom_connector_values" DROP CONSTRAINT "org_custom_connector_values_connector_id_org_custom_connectors_id_fk";
--> statement-breakpoint
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_connector_id_connectors_id_fk";
--> statement-breakpoint
ALTER TABLE "user_custom_connectors" DROP CONSTRAINT "user_custom_connectors_custom_connector_id_org_custom_connectors_id_fk";
--> statement-breakpoint
DROP INDEX "idx_connectors_org_user_type";--> statement-breakpoint
DROP INDEX "idx_secrets_org_user_name_type";--> statement-breakpoint
ALTER TABLE "agent_run_custom_connector_auth_refs" ALTER COLUMN "encrypted_value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_custom_connector_auth_refs" ADD COLUMN "connector_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "custom_connector_id" uuid;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "connector_revision" integer;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "custom_connector_id" uuid;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "auth_mode" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "permission_bundle_ref" varchar(128);--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "mcp_endpoint" text;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "mcp_transport" varchar(32);--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "mcp_resource" text;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "skill_markdown" text;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD COLUMN "connector_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD COLUMN "permission_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD COLUMN "allow_all_mcp_tools" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD COLUMN "mcp_tool_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "org_custom_connector_secrets" AS secret_row
SET "org_id" = connector."org_id"
FROM "org_custom_connectors" AS connector
WHERE secret_row."connector_id" = connector."id"
	AND secret_row."org_id" IS DISTINCT FROM connector."org_id";--> statement-breakpoint
DELETE FROM "org_custom_connector_secrets" AS secret_row
WHERE NOT EXISTS (
	SELECT 1
	FROM "org_custom_connectors" AS connector
	WHERE connector."id" = secret_row."connector_id"
);--> statement-breakpoint
UPDATE "org_custom_connector_values" AS value_row
SET "org_id" = connector."org_id"
FROM "org_custom_connectors" AS connector
WHERE value_row."connector_id" = connector."id"
	AND value_row."org_id" IS DISTINCT FROM connector."org_id";--> statement-breakpoint
UPDATE "user_custom_connectors" AS grant_row
SET "org_id" = connector."org_id"
FROM "org_custom_connectors" AS connector
WHERE grant_row."custom_connector_id" = connector."id"
	AND grant_row."org_id" IS DISTINCT FROM connector."org_id";--> statement-breakpoint
UPDATE "secrets" AS secret_row
SET
	"org_id" = connector."org_id",
	"user_id" = connector."user_id"
FROM "connectors" AS connector
WHERE secret_row."connector_id" = connector."id"
	AND (
		secret_row."org_id" IS DISTINCT FROM connector."org_id"
		OR secret_row."user_id" IS DISTINCT FROM connector."user_id"
	);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_id_org_user" ON "connectors" USING btree ("id","org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_custom_connectors_id_org" ON "org_custom_connectors" USING btree ("id","org_id");--> statement-breakpoint
ALTER TABLE "org_custom_connector_oauth_configs" ADD CONSTRAINT "fk_org_custom_connector_oauth_configs_connector" FOREIGN KEY ("connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "fk_connector_oauth_states_custom_connector" FOREIGN KEY ("custom_connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "fk_connectors_custom_connector" FOREIGN KEY ("custom_connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_custom_connector_secrets" ADD CONSTRAINT "fk_org_custom_connector_secrets_connector" FOREIGN KEY ("connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_custom_connector_values" ADD CONSTRAINT "fk_org_custom_connector_values_connector" FOREIGN KEY ("connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "fk_secrets_connector_owner" FOREIGN KEY ("connector_id","org_id","user_id") REFERENCES "public"."connectors"("id","org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD CONSTRAINT "fk_user_custom_connectors_custom_connector" FOREIGN KEY ("custom_connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_org_user_custom_connector" ON "connectors" USING btree ("org_id","user_id","custom_connector_id") WHERE "connectors"."custom_connector_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_secrets_connector_name" ON "secrets" USING btree ("connector_id","name") WHERE "secrets"."connector_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_org_user_type" ON "connectors" USING btree ("org_id","user_id","type") WHERE "connectors"."type" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_secrets_org_user_name_type" ON "secrets" USING btree ("org_id","user_id","name","type") WHERE "secrets"."connector_id" IS NULL;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "chk_connector_oauth_states_identity" CHECK (num_nonnulls("connector_oauth_states"."type", "connector_oauth_states"."custom_connector_id") = 1);--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "chk_connector_oauth_states_custom_revision" CHECK ((
          "connector_oauth_states"."custom_connector_id" IS NULL
          AND "connector_oauth_states"."connector_revision" IS NULL
        ) OR (
          "connector_oauth_states"."custom_connector_id" IS NOT NULL
          AND "connector_oauth_states"."connector_revision" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "chk_connectors_identity" CHECK (num_nonnulls("connectors"."type", "connectors"."custom_connector_id") = 1);--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_slug" CHECK (left("org_custom_connectors"."slug", 1) = '_');--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_auth_mode" CHECK ("org_custom_connectors"."auth_mode" IN ('manual', 'oauth'));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_mcp" CHECK ((
          "org_custom_connectors"."mcp_endpoint" IS NULL
          AND "org_custom_connectors"."mcp_transport" IS NULL
        ) OR (
          "org_custom_connectors"."mcp_endpoint" IS NOT NULL
          AND "org_custom_connectors"."mcp_transport" = 'streamable-http'
        ));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_revision_positive" CHECK ("org_custom_connectors"."revision" > 0);--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_skill_size" CHECK ("org_custom_connectors"."skill_markdown" IS NULL OR octet_length("org_custom_connectors"."skill_markdown") <= 65536);--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD CONSTRAINT "chk_user_custom_connectors_mcp_grant" CHECK (NOT "user_custom_connectors"."allow_all_mcp_tools" OR cardinality("user_custom_connectors"."mcp_tool_names") = 0);
