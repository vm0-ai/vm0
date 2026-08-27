CREATE TABLE "official_workflow_reconciliation_work" (
	"definition_name" varchar(64) PRIMARY KEY NOT NULL,
	"requested_release_id" varchar(64) NOT NULL,
	"cursor_workflow_id" uuid,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "official_workflow_reconciliation_work_state_check" CHECK ((
          "official_workflow_reconciliation_work"."state" = 'pending'
          AND "official_workflow_reconciliation_work"."lease_id" IS NULL
          AND "official_workflow_reconciliation_work"."lease_expires_at" IS NULL
        ) OR (
          "official_workflow_reconciliation_work"."state" = 'running'
          AND "official_workflow_reconciliation_work"."lease_id" IS NOT NULL
          AND "official_workflow_reconciliation_work"."lease_expires_at" IS NOT NULL
        )),
	CONSTRAINT "official_workflow_reconciliation_work_attempt_count_check" CHECK ("official_workflow_reconciliation_work"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "official_workflow_automation_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"automation_id" uuid,
	"blueprint_key" varchar(64) NOT NULL,
	"state" varchar(32) NOT NULL,
	"retained_parameter_bindings" jsonb,
	"retained_intended_enabled" boolean,
	"retained_applied_fingerprint" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "official_workflow_automation_identities_state_check" CHECK ((
          "official_workflow_automation_identities"."state" = 'active'
          AND "official_workflow_automation_identities"."automation_id" IS NOT NULL
          AND "official_workflow_automation_identities"."retained_parameter_bindings" IS NULL
          AND "official_workflow_automation_identities"."retained_intended_enabled" IS NULL
          AND "official_workflow_automation_identities"."retained_applied_fingerprint" IS NULL
        ) OR (
          "official_workflow_automation_identities"."state" IN ('reconciling', 'needs_reconfiguration', 'failed', 'removed')
          AND "official_workflow_automation_identities"."automation_id" IS NULL
          AND jsonb_typeof("official_workflow_automation_identities"."retained_parameter_bindings") = 'array'
          AND "official_workflow_automation_identities"."retained_intended_enabled" IS NOT NULL
          AND (
            "official_workflow_automation_identities"."retained_applied_fingerprint" IS NULL
            OR "official_workflow_automation_identities"."retained_applied_fingerprint" ~ '^[0-9a-f]{64}$'
          )
        ))
);
--> statement-breakpoint
ALTER TABLE "official_workflow_reconciliation_work" ADD CONSTRAINT "official_workflow_reconciliation_work_requested_release_id_official_workflow_catalog_releases_id_fk" FOREIGN KEY ("requested_release_id") REFERENCES "public"."official_workflow_catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_workflow_automation_identities" ADD CONSTRAINT "official_workflow_automation_identity_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."zero_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_workflow_automation_identities" ADD CONSTRAINT "official_workflow_automation_identity_automation_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_official_workflow_reconciliation_work_due" ON "official_workflow_reconciliation_work" USING btree ("available_at","definition_name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_official_workflow_automation_identities_key" ON "official_workflow_automation_identities" USING btree ("workflow_id","blueprint_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_official_workflow_automation_identities_automation_unique" ON "official_workflow_automation_identities" USING btree ("automation_id") WHERE "official_workflow_automation_identities"."automation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_official_workflow_automation_identities_workflow" ON "official_workflow_automation_identities" USING btree ("workflow_id");