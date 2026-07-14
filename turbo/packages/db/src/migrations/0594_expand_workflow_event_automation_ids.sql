-- Expand both low-volume event bookkeeping tables before application reads and
-- writes switch to automation_id. The trigger keeps old and new API releases
-- writable throughout the deployment and rollback window.
ALTER TABLE "zero_workflow_github_processed_events" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" ADD COLUMN "automation_id" uuid;--> statement-breakpoint

UPDATE "zero_workflow_github_processed_events" SET "automation_id" = "trigger_id";--> statement-breakpoint
UPDATE "zero_workflow_webhook_deliveries" SET "automation_id" = "trigger_id";--> statement-breakpoint

CREATE FUNCTION "sync_workflow_event_automation_id"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."automation_id" IS NULL THEN
      NEW."automation_id" := NEW."trigger_id";
    ELSIF NEW."trigger_id" IS NULL THEN
      NEW."trigger_id" := NEW."automation_id";
    ELSIF NEW."automation_id" IS DISTINCT FROM NEW."trigger_id" THEN
      RAISE EXCEPTION 'automation_id and trigger_id must match';
    END IF;
  ELSE
    IF NEW."automation_id" IS DISTINCT FROM OLD."automation_id"
      AND NEW."trigger_id" IS NOT DISTINCT FROM OLD."trigger_id" THEN
      NEW."trigger_id" := NEW."automation_id";
    ELSIF NEW."trigger_id" IS DISTINCT FROM OLD."trigger_id"
      AND NEW."automation_id" IS NOT DISTINCT FROM OLD."automation_id" THEN
      NEW."automation_id" := NEW."trigger_id";
    ELSIF NEW."automation_id" IS DISTINCT FROM NEW."trigger_id" THEN
      RAISE EXCEPTION 'automation_id and trigger_id must match';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "sync_workflow_github_processed_events_automation_id"
BEFORE INSERT OR UPDATE ON "zero_workflow_github_processed_events"
FOR EACH ROW EXECUTE FUNCTION "sync_workflow_event_automation_id"();--> statement-breakpoint
CREATE TRIGGER "sync_workflow_webhook_deliveries_automation_id"
BEFORE INSERT OR UPDATE ON "zero_workflow_webhook_deliveries"
FOR EACH ROW EXECUTE FUNCTION "sync_workflow_event_automation_id"();--> statement-breakpoint

ALTER TABLE "zero_workflow_github_processed_events" ALTER COLUMN "automation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" ALTER COLUMN "automation_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "zero_workflow_github_processed_events" ADD CONSTRAINT "zero_workflow_github_processed_events_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" ADD CONSTRAINT "zero_workflow_webhook_deliveries_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "zero_workflow_github_processed_events" VALIDATE CONSTRAINT "zero_workflow_github_processed_events_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries" VALIDATE CONSTRAINT "zero_workflow_webhook_deliveries_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint

CREATE UNIQUE INDEX "idx_zero_workflow_github_processed_automation_delivery" ON "zero_workflow_github_processed_events" USING btree ("automation_id","github_delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_webhook_deliveries_automation_key" ON "zero_workflow_webhook_deliveries" USING btree ("automation_id","delivery_key");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_webhook_deliveries_automation_received" ON "zero_workflow_webhook_deliveries" USING btree ("automation_id","received_at");
