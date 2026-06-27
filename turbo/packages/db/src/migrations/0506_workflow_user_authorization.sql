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
INSERT INTO "workflow_user_connectors" ("org_id", "user_id", "workflow_id", "connector_type")
SELECT DISTINCT
	"zero_workflow_triggers"."org_id",
	"zero_workflow_triggers"."owner_user_id",
	"zero_workflow_triggers"."workflow_id",
	legacy_connector.connector_type
FROM "zero_workflow_triggers"
CROSS JOIN LATERAL jsonb_array_elements_text(
	COALESCE("zero_workflow_triggers"."unattended_connector_refs", '[]'::jsonb)
) AS legacy_connector(connector_type)
WHERE legacy_connector.connector_type <> ''
ON CONFLICT ("org_id", "user_id", "workflow_id", "connector_type") DO NOTHING;--> statement-breakpoint
WITH legacy_grants AS (
	SELECT
		"zero_workflow_triggers"."org_id",
		"zero_workflow_triggers"."owner_user_id" AS "user_id",
		"zero_workflow_triggers"."workflow_id",
		legacy_connector.connector_ref,
		legacy_permission.permission,
		bool_or(legacy_permission.action = 'deny') AS has_deny
	FROM "zero_workflow_triggers"
	CROSS JOIN LATERAL jsonb_each(
		COALESCE("zero_workflow_triggers"."unattended_permission_policy", '{}'::jsonb)
	) AS legacy_connector(connector_ref, connector_policy)
	CROSS JOIN LATERAL jsonb_each_text(
		COALESCE(legacy_connector.connector_policy -> 'policies', '{}'::jsonb)
	) AS legacy_permission(permission, action)
	WHERE legacy_connector.connector_ref <> ''
		AND legacy_permission.permission <> ''
		AND legacy_permission.action IN ('allow', 'deny')
	GROUP BY
		"zero_workflow_triggers"."org_id",
		"zero_workflow_triggers"."owner_user_id",
		"zero_workflow_triggers"."workflow_id",
		legacy_connector.connector_ref,
		legacy_permission.permission
)
INSERT INTO "workflow_user_permission_grants" (
	"org_id",
	"user_id",
	"workflow_id",
	"connector_ref",
	"permission",
	"action"
)
SELECT
	legacy_grants."org_id",
	legacy_grants."user_id",
	legacy_grants."workflow_id",
	legacy_grants.connector_ref,
	legacy_grants.permission,
	CASE WHEN legacy_grants.has_deny THEN 'deny' ELSE 'allow' END
FROM legacy_grants
ON CONFLICT ("org_id", "user_id", "workflow_id", "connector_ref", "permission") DO NOTHING;
