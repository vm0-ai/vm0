CREATE TABLE "org_custom_connector_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"key" varchar(64) NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "prefix_templates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "header_injections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "query_injections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_custom_connector_values" ADD CONSTRAINT "org_custom_connector_values_connector_id_org_custom_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."org_custom_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "org_custom_connectors"
SET
	"prefix_templates" = "prefixes",
	"fields" = jsonb_build_array(
		jsonb_build_object(
			'key', 'secret',
			'label', 'Secret',
			'kind', 'secret',
			'required', true,
			'description', 'API credential'
		)
	),
	"header_injections" = jsonb_build_array(
		jsonb_build_object(
			'name', "header_name",
			'valueTemplate', replace("header_template", '{{secret}}', '{{secrets.secret}}')
		)
	),
	"query_injections" = '[]'::jsonb
WHERE "fields" = '[]'::jsonb;--> statement-breakpoint
INSERT INTO "org_custom_connector_values" (
	"connector_id",
	"user_id",
	"org_id",
	"kind",
	"key",
	"encrypted_value",
	"created_at",
	"updated_at"
)
SELECT
	"connector_id",
	"user_id",
	"org_id",
	'secret',
	'secret',
	"encrypted_value",
	"created_at",
	"updated_at"
FROM "org_custom_connector_secrets"
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE INDEX "idx_org_custom_connector_values_connector" ON "org_custom_connector_values" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_org_custom_connector_values_user" ON "org_custom_connector_values" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_custom_connector_values_unique" ON "org_custom_connector_values" USING btree ("connector_id","user_id","kind","key");
