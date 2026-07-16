CREATE TABLE "zero_workflow_trigger_memory_embeddings" (
	"workflow_trigger_id" uuid PRIMARY KEY NOT NULL,
	"embedding_model" text NOT NULL,
	"query_hash" varchar(64) NOT NULL,
	"embedding" real[] NOT NULL,
	CONSTRAINT "zero_workflow_trigger_memory_embeddings_dimensions_check" CHECK (cardinality("zero_workflow_trigger_memory_embeddings"."embedding") = 1536)
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_trigger_memory_embeddings" ADD CONSTRAINT "zero_workflow_trigger_memory_embeddings_workflow_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("workflow_trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;