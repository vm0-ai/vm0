CREATE TABLE "user_permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"connector_ref" varchar(64) NOT NULL,
	"permission" varchar(128) NOT NULL,
	"action" varchar(8) NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_user_permission_grants_action" CHECK ("user_permission_grants"."action" IN ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_permission_grants_grant" ON "user_permission_grants" USING btree ("org_id","user_id","agent_id","connector_ref","permission");--> statement-breakpoint
CREATE INDEX "idx_user_permission_grants_lookup" ON "user_permission_grants" USING btree ("org_id","user_id","agent_id");
