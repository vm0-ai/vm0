DROP TABLE "memories" CASCADE;--> statement-breakpoint
DROP TABLE "memory_context_spaces" CASCADE;--> statement-breakpoint
DROP TABLE "memory_document_chunks" CASCADE;--> statement-breakpoint
DROP TABLE "memory_document_search_entries" CASCADE;--> statement-breakpoint
DROP TABLE "memory_documents" CASCADE;--> statement-breakpoint
DROP TABLE "memory_edges" CASCADE;--> statement-breakpoint
DROP TABLE "memory_entities" CASCADE;--> statement-breakpoint
DROP TABLE "memory_entity_aliases" CASCADE;--> statement-breakpoint
DROP TABLE "memory_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "memory_search_entries" CASCADE;--> statement-breakpoint
DROP TABLE "memory_source_links" CASCADE;--> statement-breakpoint
DROP TABLE "memory_sources" CASCADE;--> statement-breakpoint
DROP TABLE "memory_tombstones" CASCADE;--> statement-breakpoint
DROP TABLE "memory_versions" CASCADE;--> statement-breakpoint
DROP TABLE "relationship_backfill_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "relationship_memory_settings" CASCADE;--> statement-breakpoint
DROP TABLE "relationship_sync_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "thread_goal_memory_embeddings" CASCADE;--> statement-breakpoint
DROP TABLE "zero_workflow_automation_memory_embeddings" CASCADE;--> statement-breakpoint
UPDATE "user_feature_switches"
SET
	"switches" = "switches" - 'relationshipMemory' - 'relationshipMemoryRuntimeInjection',
	"updated_at" = NOW()
WHERE "switches" ?| ARRAY['relationshipMemory', 'relationshipMemoryRuntimeInjection'];--> statement-breakpoint
UPDATE "github_installations"
SET
	"repo_configs" = "repo_configs" - 'memory',
	"updated_at" = NOW()
WHERE "repo_configs" ? 'memory';
