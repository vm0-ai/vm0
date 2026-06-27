CREATE TABLE "workflow_user_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"connector_type" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_user_permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"connector_ref" varchar(64) NOT NULL,
	"permission" varchar(128) NOT NULL,
	"action" varchar(8) NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_workflow_user_permission_grants_action" CHECK ("workflow_user_permission_grants"."action" IN ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "workflow_user_connectors" ADD CONSTRAINT "workflow_user_connectors_workflow_id_zero_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."zero_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_user_permission_grants" ADD CONSTRAINT "workflow_user_permission_grants_workflow_id_zero_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."zero_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_user_connectors_unique" ON "workflow_user_connectors" USING btree ("org_id","user_id","workflow_id","connector_type");--> statement-breakpoint
CREATE INDEX "idx_workflow_user_connectors_workflow_user" ON "workflow_user_connectors" USING btree ("workflow_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_user_permission_grants_grant" ON "workflow_user_permission_grants" USING btree ("org_id","user_id","workflow_id","connector_ref","permission");--> statement-breakpoint
CREATE INDEX "idx_workflow_user_permission_grants_lookup" ON "workflow_user_permission_grants" USING btree ("org_id","user_id","workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_user_permission_grants_user_id" ON "workflow_user_permission_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_user_permission_grants_workflow_id" ON "workflow_user_permission_grants" USING btree ("workflow_id");--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "unattended_connector_refs";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "unattended_permission_policy";