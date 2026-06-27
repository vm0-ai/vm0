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
WITH legacy_connector_refs AS (
	SELECT
		"zero_workflow_triggers"."org_id",
		"zero_workflow_triggers"."owner_user_id" AS "user_id",
		"zero_workflow_triggers"."workflow_id",
		"legacy_connector"."connector_type"
	FROM "zero_workflow_triggers"
	CROSS JOIN LATERAL jsonb_array_elements_text(
		CASE
			WHEN jsonb_typeof("zero_workflow_triggers"."unattended_connector_refs") = 'array'
				THEN "zero_workflow_triggers"."unattended_connector_refs"
			ELSE '[]'::jsonb
		END
	) AS "legacy_connector"("connector_type")
	WHERE "legacy_connector"."connector_type" <> ''
	UNION
	SELECT
		"zero_workflow_triggers"."org_id",
		"zero_workflow_triggers"."owner_user_id" AS "user_id",
		"zero_workflow_triggers"."workflow_id",
		"legacy_connector"."connector_type"
	FROM "zero_workflow_triggers"
	CROSS JOIN LATERAL jsonb_each(
		CASE
			WHEN jsonb_typeof("zero_workflow_triggers"."unattended_permission_policy") = 'object'
				THEN "zero_workflow_triggers"."unattended_permission_policy"
			ELSE '{}'::jsonb
		END
	) AS "legacy_connector"("connector_type", "connector_policy")
	WHERE "legacy_connector"."connector_type" <> ''
)
INSERT INTO "workflow_user_connectors" ("org_id", "user_id", "workflow_id", "connector_type")
SELECT DISTINCT
	"org_id",
	"user_id",
	"workflow_id",
	"connector_type"
FROM "legacy_connector_refs"
ON CONFLICT ("org_id", "user_id", "workflow_id", "connector_type") DO NOTHING;--> statement-breakpoint
WITH legacy_permission_entries AS (
	SELECT
		"zero_workflow_triggers"."org_id",
		"zero_workflow_triggers"."owner_user_id" AS "user_id",
		"zero_workflow_triggers"."workflow_id",
		"legacy_connector"."connector_ref",
		"legacy_permission"."permission",
		"legacy_permission"."action"
	FROM "zero_workflow_triggers"
	CROSS JOIN LATERAL jsonb_each(
		CASE
			WHEN jsonb_typeof("zero_workflow_triggers"."unattended_permission_policy") = 'object'
				THEN "zero_workflow_triggers"."unattended_permission_policy"
			ELSE '{}'::jsonb
		END
	) AS "legacy_connector"("connector_ref", "connector_policy")
	CROSS JOIN LATERAL jsonb_each_text(
		CASE
			WHEN jsonb_typeof("legacy_connector"."connector_policy" -> 'policies') = 'object'
				THEN "legacy_connector"."connector_policy" -> 'policies'
			ELSE '{}'::jsonb
		END
	) AS "legacy_permission"("permission", "action")
	WHERE "legacy_connector"."connector_ref" <> ''
		AND "legacy_permission"."permission" <> ''
	UNION ALL
	SELECT
		"zero_workflow_triggers"."org_id",
		"zero_workflow_triggers"."owner_user_id" AS "user_id",
		"zero_workflow_triggers"."workflow_id",
		"legacy_connector"."connector_ref",
		'__unknown__' AS "permission",
		"legacy_connector"."connector_policy" ->> 'unknownPolicy' AS "action"
	FROM "zero_workflow_triggers"
	CROSS JOIN LATERAL jsonb_each(
		CASE
			WHEN jsonb_typeof("zero_workflow_triggers"."unattended_permission_policy") = 'object'
				THEN "zero_workflow_triggers"."unattended_permission_policy"
			ELSE '{}'::jsonb
		END
	) AS "legacy_connector"("connector_ref", "connector_policy")
	WHERE "legacy_connector"."connector_ref" <> ''
		AND "legacy_connector"."connector_policy" ? 'unknownPolicy'
),
legacy_permission_grants AS (
	SELECT
		"org_id",
		"user_id",
		"workflow_id",
		"connector_ref",
		"permission",
		bool_or("action" = 'deny') AS "has_deny",
		bool_or("action" = 'allow') AS "has_allow"
	FROM "legacy_permission_entries"
	WHERE "action" IN ('allow', 'deny')
	GROUP BY
		"org_id",
		"user_id",
		"workflow_id",
		"connector_ref",
		"permission"
)
INSERT INTO "workflow_user_permission_grants" ("org_id", "user_id", "workflow_id", "connector_ref", "permission", "action")
SELECT
	"org_id",
	"user_id",
	"workflow_id",
	"connector_ref",
	"permission",
	CASE WHEN "has_deny" THEN 'deny' ELSE 'allow' END
FROM "legacy_permission_grants"
WHERE "has_deny" OR "has_allow"
ON CONFLICT ("org_id", "user_id", "workflow_id", "connector_ref", "permission") DO UPDATE
SET
	"action" = CASE
		WHEN "workflow_user_permission_grants"."action" = 'deny' OR EXCLUDED."action" = 'deny'
			THEN 'deny'
		ELSE 'allow'
	END,
	"expires_at" = NULL,
	"updated_at" = now();--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "unattended_connector_refs";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "unattended_permission_policy";
