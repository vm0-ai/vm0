CREATE TABLE "official_automation_result_email_claims" (
	"run_id" uuid NOT NULL,
	"workflow_automation_id" uuid NOT NULL,
	"email_outbox_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "official_automation_result_email_claims_pkey" PRIMARY KEY("run_id","workflow_automation_id")
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" DROP CONSTRAINT "zero_workflow_automations_official_binding_check";--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "source_run_id" uuid;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "source_workflow_automation_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD COLUMN "official_result_email_enabled" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "official_automation_result_email_claims_outbox_unique" ON "official_automation_result_email_claims" USING btree ("email_outbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_source_run_automation_unique" ON "email_outbox" USING btree ("source_run_id","source_workflow_automation_id");--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_source_identity_check" CHECK ((
          "email_outbox"."source_run_id" IS NULL
          AND "email_outbox"."source_workflow_automation_id" IS NULL
        ) OR (
          "email_outbox"."source_run_id" IS NOT NULL
          AND "email_outbox"."source_workflow_automation_id" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD CONSTRAINT "zero_workflow_automations_official_binding_check" CHECK ((
          "zero_workflow_automations"."official_blueprint_key" IS NULL
          AND "zero_workflow_automations"."official_applied_fingerprint" IS NULL
          AND "zero_workflow_automations"."official_reconciliation_status" IS NULL
          AND "zero_workflow_automations"."official_parameter_bindings" IS NULL
          AND "zero_workflow_automations"."official_intended_enabled" IS NULL
          AND "zero_workflow_automations"."official_result_email_enabled" IS NULL
        ) OR (
          "zero_workflow_automations"."official_blueprint_key" IS NOT NULL
          AND "zero_workflow_automations"."official_applied_fingerprint" ~ '^[0-9a-f]{64}$'
          AND "zero_workflow_automations"."official_reconciliation_status" IN ('current', 'reconciling', 'needs_reconfiguration', 'failed')
          AND jsonb_typeof("zero_workflow_automations"."official_parameter_bindings") = 'array'
          AND "zero_workflow_automations"."official_intended_enabled" IS NOT NULL
          AND "zero_workflow_automations"."official_result_email_enabled" IS NOT NULL
        ));