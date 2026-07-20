-- Expand the workflow-event queue identifier before application reads and
-- writes switch to automation_id. User-message rows keep both identifiers
-- null. The trigger keeps old and new API releases writable throughout the
-- deployment and rollback window.
ALTER TABLE "chat_message_queue" ADD COLUMN "automation_id" uuid;--> statement-breakpoint

UPDATE "chat_message_queue"
SET "automation_id" = "trigger_id"
WHERE "trigger_id" IS NOT NULL;--> statement-breakpoint

CREATE FUNCTION "sync_chat_message_queue_automation_id"() RETURNS trigger AS $$
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

CREATE TRIGGER "sync_chat_message_queue_automation_id"
BEFORE INSERT OR UPDATE ON "chat_message_queue"
FOR EACH ROW EXECUTE FUNCTION "sync_chat_message_queue_automation_id"();--> statement-breakpoint

ALTER TABLE "chat_message_queue" ADD CONSTRAINT "chat_message_queue_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_message_queue" VALIDATE CONSTRAINT "chat_message_queue_automation_id_zero_workflow_automations_id_fk";--> statement-breakpoint

CREATE INDEX "idx_chat_message_queue_automation" ON "chat_message_queue" USING btree ("automation_id") WHERE "chat_message_queue"."automation_id" IS NOT NULL;
