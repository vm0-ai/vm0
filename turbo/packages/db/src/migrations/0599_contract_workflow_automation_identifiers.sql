-- Contract the Automation identifier columns after the canonical API has been
-- live for a full rollback release. Remove the synchronization machinery
-- before dropping the legacy columns it references.
DROP TRIGGER "sync_zero_runs_workflow_automation_id" ON "zero_runs";--> statement-breakpoint
DROP FUNCTION "sync_zero_runs_workflow_automation_id"();--> statement-breakpoint
DROP TRIGGER "sync_workflow_automation_memory_id" ON "zero_workflow_automation_memory_embeddings";--> statement-breakpoint
DROP FUNCTION "sync_workflow_automation_memory_id"();--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" DROP CONSTRAINT "zero_workflow_automation_memory_embeddings_automation_id_uq";--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" DROP CONSTRAINT "zero_workflow_automation_memory_embeddings_pkey";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP CONSTRAINT "zero_runs_workflow_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" DROP CONSTRAINT "zero_workflow_automation_memory_embeddings_workflow_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" DROP CONSTRAINT "zero_workflow_automation_memory_embeddings_automation_id_fk";
--> statement-breakpoint
DROP INDEX "idx_zero_runs_workflow_trigger";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "workflow_trigger_id";--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" DROP COLUMN "workflow_trigger_id";--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" ADD PRIMARY KEY ("workflow_automation_id");--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" ADD CONSTRAINT "zero_workflow_automation_memory_embeddings_workflow_automation_id_zero_workflow_automations_id_fk" FOREIGN KEY ("workflow_automation_id") REFERENCES "public"."zero_workflow_automations"("id") ON DELETE cascade ON UPDATE no action;
