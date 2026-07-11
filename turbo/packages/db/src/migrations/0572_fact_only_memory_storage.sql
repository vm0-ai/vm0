-- Custom SQL migration file, put your code below! --
DELETE FROM "memory_versions"
WHERE "target_kind" IN ('document', 'document_chunk');

DELETE FROM "memory_tombstones"
WHERE "target_kind" IN ('document', 'document_chunk');

DELETE FROM "memories"
WHERE "kind" = 'recent_context';

DELETE FROM "memory_documents";

DROP INDEX "idx_memory_search_entries_embedding_hnsw";
CREATE INDEX "idx_memory_search_entries_embedding_hnsw" ON "memory_search_entries" USING hnsw ("embedding" vector_cosine_ops);
