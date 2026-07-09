ALTER TABLE "memories" ADD COLUMN "context_space_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_profiles" ADD COLUMN "context_space_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_search_entries" ADD COLUMN "context_space_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_profiles" ADD CONSTRAINT "memory_profiles_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_search_entries" ADD CONSTRAINT "memory_search_entries_context_space_id_memory_context_spaces_id_fk" FOREIGN KEY ("context_space_id") REFERENCES "public"."memory_context_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memories_context_status" ON "memories" USING btree ("context_space_id","status");--> statement-breakpoint
CREATE INDEX "idx_memory_profiles_context" ON "memory_profiles" USING btree ("context_space_id");--> statement-breakpoint
CREATE INDEX "idx_memory_search_entries_context" ON "memory_search_entries" USING btree ("context_space_id");