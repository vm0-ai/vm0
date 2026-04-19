CREATE TABLE "org_custom_connector_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_custom_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"prefixes" jsonb NOT NULL,
	"header_name" varchar(128) NOT NULL,
	"header_template" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_org_custom_connector_secrets_connector" ON "org_custom_connector_secrets" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_org_custom_connector_secrets_user" ON "org_custom_connector_secrets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_custom_connector_secrets_connector_user" ON "org_custom_connector_secrets" USING btree ("connector_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_org_custom_connectors_org" ON "org_custom_connectors" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_custom_connectors_org_slug" ON "org_custom_connectors" USING btree ("org_id","slug");