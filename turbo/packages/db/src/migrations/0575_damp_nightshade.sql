CREATE TABLE "thread_goal_memory_embeddings" (
	"goal_id" uuid PRIMARY KEY NOT NULL,
	"embedding_model" text NOT NULL,
	"query_hash" varchar(64) NOT NULL,
	"embedding" real[] NOT NULL,
	CONSTRAINT "thread_goal_memory_embeddings_dimensions_check" CHECK (cardinality("thread_goal_memory_embeddings"."embedding") = 1536)
);
--> statement-breakpoint
ALTER TABLE "thread_goal_memory_embeddings" ADD CONSTRAINT "thread_goal_memory_embeddings_goal_id_thread_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."thread_goals"("id") ON DELETE cascade ON UPDATE no action;