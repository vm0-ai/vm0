ALTER TABLE "connectors" ADD COLUMN "storage_version" bigint;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "variables" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_secrets_connector" ON "secrets" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_variables_connector" ON "variables" USING btree ("connector_id");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "chk_connectors_storage_version_positive" CHECK ("connectors"."storage_version" IS NULL OR "connectors"."storage_version" > 0);--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "chk_secrets_connector_owner_type" CHECK ("secrets"."connector_id" IS NULL OR "secrets"."type" = 'connector');--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "chk_variables_connector_owner_type" CHECK ("variables"."connector_id" IS NULL OR "variables"."type" = 'connector');