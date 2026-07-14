-- Expand the memory-cache entity identifier before application reads and
-- writes switch to workflow_automation_id. The legacy primary key remains the
-- old API's conflict target while the canonical unique constraint serves the
-- new API throughout the deployment and rollback window.
ALTER TABLE "zero_workflow_automation_memory_embeddings" ADD COLUMN "workflow_automation_id" uuid;--> statement-breakpoint

CREATE FUNCTION "sync_workflow_automation_memory_id"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."workflow_automation_id" IS NULL THEN
      NEW."workflow_automation_id" := NEW."workflow_trigger_id";
    ELSIF NEW."workflow_trigger_id" IS NULL THEN
      NEW."workflow_trigger_id" := NEW."workflow_automation_id";
    ELSIF NEW."workflow_automation_id" IS DISTINCT FROM NEW."workflow_trigger_id" THEN
      RAISE EXCEPTION 'workflow_automation_id and its legacy identifier must match';
    END IF;
  ELSE
    IF NEW."workflow_automation_id" IS DISTINCT FROM OLD."workflow_automation_id"
      AND NEW."workflow_trigger_id" IS NOT DISTINCT FROM OLD."workflow_trigger_id" THEN
      NEW."workflow_trigger_id" := NEW."workflow_automation_id";
    ELSIF NEW."workflow_trigger_id" IS DISTINCT FROM OLD."workflow_trigger_id"
      AND NEW."workflow_automation_id" IS NOT DISTINCT FROM OLD."workflow_automation_id" THEN
      NEW."workflow_automation_id" := NEW."workflow_trigger_id";
    ELSIF NEW."workflow_automation_id" IS DISTINCT FROM NEW."workflow_trigger_id" THEN
      RAISE EXCEPTION 'workflow_automation_id and its legacy identifier must match';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "sync_workflow_automation_memory_id"
BEFORE INSERT OR UPDATE ON "zero_workflow_automation_memory_embeddings"
FOR EACH ROW EXECUTE FUNCTION "sync_workflow_automation_memory_id"();--> statement-breakpoint

UPDATE "zero_workflow_automation_memory_embeddings"
SET "workflow_automation_id" = "workflow_trigger_id";--> statement-breakpoint

ALTER TABLE "zero_workflow_automation_memory_embeddings" ALTER COLUMN "workflow_automation_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "zero_workflow_automation_memory_embeddings" ADD CONSTRAINT "zero_workflow_automation_memory_embeddings_automation_id_fk" FOREIGN KEY ("workflow_automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" VALIDATE CONSTRAINT "zero_workflow_automation_memory_embeddings_automation_id_fk";--> statement-breakpoint

ALTER TABLE "zero_workflow_automation_memory_embeddings" ADD CONSTRAINT "zero_workflow_automation_memory_embeddings_automation_id_uq" UNIQUE("workflow_automation_id");
