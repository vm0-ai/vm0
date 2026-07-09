CREATE INDEX "idx_memory_search_entries_embedding_hnsw" ON "memory_search_entries" USING hnsw (embedding vector_cosine_ops);
