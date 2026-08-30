ALTER TABLE "zero_workflow_automations" ADD COLUMN "official_blueprint_key" varchar(64);--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD COLUMN "official_applied_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD COLUMN "official_reconciliation_status" varchar(32);--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD COLUMN "official_parameter_bindings" jsonb;--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD COLUMN "official_intended_enabled" boolean;--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD COLUMN "official_definition_name" varchar(64);--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD COLUMN "official_installation_state" varchar(32);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_automations_official_blueprint_unique" ON "zero_workflow_automations" USING btree ("workflow_id","official_blueprint_key") WHERE "zero_workflow_automations"."official_blueprint_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD CONSTRAINT "zero_workflow_automations_official_binding_check" CHECK ((
          "zero_workflow_automations"."official_blueprint_key" IS NULL
          AND "zero_workflow_automations"."official_applied_fingerprint" IS NULL
          AND "zero_workflow_automations"."official_reconciliation_status" IS NULL
          AND "zero_workflow_automations"."official_parameter_bindings" IS NULL
          AND "zero_workflow_automations"."official_intended_enabled" IS NULL
        ) OR (
          "zero_workflow_automations"."official_blueprint_key" IS NOT NULL
          AND "zero_workflow_automations"."official_applied_fingerprint" ~ '^[0-9a-f]{64}$'
          AND "zero_workflow_automations"."official_reconciliation_status" IN ('current', 'reconciling', 'needs_reconfiguration', 'failed')
          AND jsonb_typeof("zero_workflow_automations"."official_parameter_bindings") = 'array'
          AND "zero_workflow_automations"."official_intended_enabled" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD CONSTRAINT "zero_workflows_official_installation_check" CHECK ((
          "zero_workflows"."official_definition_name" IS NULL
          AND "zero_workflows"."official_installation_state" IS NULL
        ) OR (
          "zero_workflows"."official_definition_name" IS NOT NULL
          AND "zero_workflows"."official_installation_state" IN ('installing', 'installed')
          AND "zero_workflows"."official_definition_name" = "zero_workflows"."name"
          AND "zero_workflows"."visibility" = 'private'
          AND "zero_workflows"."instruction" IS NULL
          AND "zero_workflows"."display_name" IS NULL
          AND "zero_workflows"."description" IS NULL
        ));