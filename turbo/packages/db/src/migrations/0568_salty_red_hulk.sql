CREATE TABLE "memory_context_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" varchar(32) NOT NULL,
	"key" varchar(512) NOT NULL,
	"display_name" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"context_space_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"source_id" uuid,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"token_count" integer NOT NULL,
	"citation" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_document_search_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"context_space_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" varchar(128) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"context_space_id" uuid NOT NULL,
	"source_id" uuid,
	"provider" varchar(50) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"external_id" varchar(512) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"title" text,
	"content_hash" varchar(64) NOT NULL,
	"occurred_at" timestamp,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"context_space_id" uuid,
	"target_kind" varchar(32) NOT NULL,
	"fingerprint" varchar(128) NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"context_space_id" uuid,
	"target_kind" varchar(32) NOT NULL,
	"target_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "context_space_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_document_chunks" ADD CONSTRAINT "memory_document_chunks_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_document_chunks" ADD CONSTRAINT "memory_document_chunks_document_id_memory_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."memory_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_document_chunks" ADD CONSTRAINT "memory_document_chunks_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_document_search_entries" ADD CONSTRAINT "memory_document_search_entries_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_document_search_entries" ADD CONSTRAINT "memory_document_search_entries_document_id_memory_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."memory_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_document_search_entries" ADD CONSTRAINT "memory_document_search_entries_chunk_id_memory_document_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."memory_document_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ADD CONSTRAINT "memory_tombstones_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_context_spaces_key" ON "memory_context_spaces" USING btree ("org_id","user_id","type","key");--> statement-breakpoint
CREATE INDEX "idx_memory_context_spaces_scope_type" ON "memory_context_spaces" USING btree ("org_id","user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_document_chunks_document_index" ON "memory_document_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "idx_memory_document_chunks_context_status" ON "memory_document_chunks" USING btree ("context_space_id","status");--> statement-breakpoint
CREATE INDEX "idx_memory_document_chunks_source" ON "memory_document_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_document_search_entries_chunk" ON "memory_document_search_entries" USING btree ("chunk_id","embedding_model");--> statement-breakpoint
CREATE INDEX "idx_memory_document_search_entries_scope_status" ON "memory_document_search_entries" USING btree ("org_id","user_id","status");--> statement-breakpoint
CREATE INDEX "idx_memory_document_search_entries_context" ON "memory_document_search_entries" USING btree ("context_space_id");--> statement-breakpoint
CREATE INDEX "idx_memory_document_search_entries_embedding_hnsw" ON "memory_document_search_entries" USING hnsw (embedding vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_documents_external" ON "memory_documents" USING btree ("org_id","user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_memory_documents_context_status" ON "memory_documents" USING btree ("context_space_id","status");--> statement-breakpoint
CREATE INDEX "idx_memory_documents_scope_provider" ON "memory_documents" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_tombstones_fingerprint" ON "memory_tombstones" USING btree ("org_id","user_id","target_kind","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_memory_tombstones_context" ON "memory_tombstones" USING btree ("context_space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_versions_target_version" ON "memory_versions" USING btree ("target_kind","target_id","version");--> statement-breakpoint
CREATE INDEX "idx_memory_versions_scope" ON "memory_versions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_memory_versions_context" ON "memory_versions" USING btree ("context_space_id");--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_sources_context_space" ON "memory_sources" USING btree ("context_space_id");