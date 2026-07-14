-- Expand phase for #21408. The compatibility view preserves the previous
-- table name while migrations run before the new API is promoted.
ALTER TABLE "zero_workflow_trigger_memory_embeddings" RENAME TO "zero_workflow_automation_memory_embeddings";--> statement-breakpoint

ALTER TABLE "zero_workflow_automation_memory_embeddings" RENAME CONSTRAINT "zero_workflow_trigger_memory_embeddings_pkey" TO "zero_workflow_automation_memory_embeddings_pkey";--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" RENAME CONSTRAINT "zero_workflow_trigger_memory_embeddings_workflow_trigger_id_zero_workflow_automations_id_fk" TO "zero_workflow_automation_memory_embeddings_workflow_trigger_id_zero_workflow_automations_id_fk";--> statement-breakpoint
ALTER TABLE "zero_workflow_automation_memory_embeddings" RENAME CONSTRAINT "zero_workflow_trigger_memory_embeddings_dimensions_check" TO "zero_workflow_automation_memory_embeddings_dimensions_check";--> statement-breakpoint

CREATE VIEW "zero_workflow_trigger_memory_embeddings" AS
SELECT
  "workflow_trigger_id",
  "embedding_model",
  "query_hash",
  "embedding"
FROM "zero_workflow_automation_memory_embeddings";
