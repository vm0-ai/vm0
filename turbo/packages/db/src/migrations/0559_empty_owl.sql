CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "memory_search_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"memory_id" uuid NOT NULL,
	"entity_id" uuid,
	"entry_kind" varchar(64) NOT NULL,
	"memory_kind" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" varchar(128) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"confidence" integer DEFAULT 80 NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_search_entries" ADD CONSTRAINT "memory_search_entries_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_search_entries" ADD CONSTRAINT "memory_search_entries_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_search_entries_memory_kind" ON "memory_search_entries" USING btree ("memory_id","entry_kind","embedding_model");--> statement-breakpoint
CREATE INDEX "idx_memory_search_entries_scope_status_kind" ON "memory_search_entries" USING btree ("org_id","user_id","status","memory_kind");--> statement-breakpoint
CREATE INDEX "idx_memory_search_entries_entity" ON "memory_search_entries" USING btree ("entity_id");
