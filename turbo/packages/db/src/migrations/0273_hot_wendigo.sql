CREATE TABLE "user_custom_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"custom_connector_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD CONSTRAINT "user_custom_connectors_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_custom_connectors" ADD CONSTRAINT "user_custom_connectors_custom_connector_id_org_custom_connectors_id_fk" FOREIGN KEY ("custom_connector_id") REFERENCES "public"."org_custom_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_custom_connectors_unique" ON "user_custom_connectors" USING btree ("org_id","user_id","agent_id","custom_connector_id");--> statement-breakpoint
CREATE INDEX "idx_user_custom_connectors_agent_user" ON "user_custom_connectors" USING btree ("agent_id","user_id");