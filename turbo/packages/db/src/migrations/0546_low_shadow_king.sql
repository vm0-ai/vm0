CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" uuid,
	"kind" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"text" text NOT NULL,
	"confidence" integer DEFAULT 80 NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"from_memory_id" uuid NOT NULL,
	"to_memory_id" uuid NOT NULL,
	"edge_type" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" varchar(32) NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" varchar(50),
	"alias_type" varchar(64) NOT NULL,
	"alias_value" varchar(512) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"section" varchar(64) NOT NULL,
	"content" text NOT NULL,
	"source_memory_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(50) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"external_id" varchar(512) NOT NULL,
	"connector_id" uuid,
	"occurred_at" timestamp,
	"title" text,
	"content_hash" varchar(64),
	"metadata" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_from_memory_id_memories_id_fk" FOREIGN KEY ("from_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_to_memory_id_memories_id_fk" FOREIGN KEY ("to_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_aliases" ADD CONSTRAINT "memory_entity_aliases_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_profiles" ADD CONSTRAINT "memory_profiles_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source_links" ADD CONSTRAINT "memory_source_links_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source_links" ADD CONSTRAINT "memory_source_links_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memories_scope_kind" ON "memories" USING btree ("org_id","user_id","kind");--> statement-breakpoint
CREATE INDEX "idx_memories_entity_status" ON "memories" USING btree ("entity_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_edges_unique" ON "memory_edges" USING btree ("from_memory_id","to_memory_id","edge_type");--> statement-breakpoint
CREATE INDEX "idx_memory_edges_to" ON "memory_edges" USING btree ("to_memory_id");--> statement-breakpoint
CREATE INDEX "idx_memory_entities_scope_type" ON "memory_entities" USING btree ("org_id","user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_entity_aliases_alias" ON "memory_entity_aliases" USING btree ("org_id","user_id","alias_type","alias_value");--> statement-breakpoint
CREATE INDEX "idx_memory_entity_aliases_entity" ON "memory_entity_aliases" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_profiles_entity_section" ON "memory_profiles" USING btree ("entity_id","section");--> statement-breakpoint
CREATE INDEX "idx_memory_profiles_scope" ON "memory_profiles" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_source_links_pair" ON "memory_source_links" USING btree ("memory_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_memory_source_links_source" ON "memory_source_links" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_sources_external" ON "memory_sources" USING btree ("org_id","user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_memory_sources_scope_provider" ON "memory_sources" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_memory_sources_occurred" ON "memory_sources" USING btree ("org_id","user_id","occurred_at" DESC NULLS LAST);