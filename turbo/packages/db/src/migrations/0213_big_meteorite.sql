CREATE TABLE "user_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"connector_type" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_connectors_unique" ON "user_connectors" USING btree ("org_id","user_id","agent_id","connector_type");--> statement-breakpoint
CREATE INDEX "idx_user_connectors_agent_user" ON "user_connectors" USING btree ("agent_id","user_id");--> statement-breakpoint
ALTER TABLE "zero_agents" DROP COLUMN "connectors";