-- Expand the hot run-provenance column before application reads and writes
-- switch to workflow_automation_id. Both names stay synchronized throughout
-- the deployment and rollback window.
ALTER TABLE "zero_runs" ADD COLUMN "workflow_automation_id" uuid;--> statement-breakpoint

UPDATE "zero_runs"
SET "workflow_automation_id" = "workflow_trigger_id"
WHERE "workflow_trigger_id" IS NOT NULL;--> statement-breakpoint

CREATE FUNCTION "sync_zero_runs_workflow_automation_id"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."workflow_automation_id" IS NULL THEN
      NEW."workflow_automation_id" := NEW."workflow_trigger_id";
    ELSIF NEW."workflow_trigger_id" IS NULL THEN
      NEW."workflow_trigger_id" := NEW."workflow_automation_id";
    ELSIF NEW."workflow_automation_id" IS DISTINCT FROM NEW."workflow_trigger_id" THEN
      RAISE EXCEPTION 'workflow_automation_id and workflow_trigger_id must match';
    END IF;
  ELSE
    IF NEW."workflow_automation_id" IS DISTINCT FROM OLD."workflow_automation_id"
      AND NEW."workflow_trigger_id" IS NOT DISTINCT FROM OLD."workflow_trigger_id" THEN
      NEW."workflow_trigger_id" := NEW."workflow_automation_id";
    ELSIF NEW."workflow_trigger_id" IS DISTINCT FROM OLD."workflow_trigger_id"
      AND NEW."workflow_automation_id" IS NOT DISTINCT FROM OLD."workflow_automation_id" THEN
      NEW."workflow_automation_id" := NEW."workflow_trigger_id";
    ELSIF NEW."workflow_automation_id" IS DISTINCT FROM NEW."workflow_trigger_id" THEN
      RAISE EXCEPTION 'workflow_automation_id and workflow_trigger_id must match';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "sync_zero_runs_workflow_automation_id"
BEFORE INSERT OR UPDATE ON "zero_runs"
FOR EACH ROW EXECUTE FUNCTION "sync_zero_runs_workflow_automation_id"();--> statement-breakpoint

ALTER TABLE "zero_runs" ADD CONSTRAINT "zero_runs_workflow_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("workflow_automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "zero_runs" VALIDATE CONSTRAINT "zero_runs_workflow_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint

CREATE INDEX "idx_zero_runs_workflow_automation" ON "zero_runs" USING btree ("workflow_automation_id") WHERE workflow_automation_id IS NOT NULL;
