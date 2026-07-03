CREATE TABLE "relationship_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" varchar(32) NOT NULL,
	"identity_key" varchar(512) NOT NULL,
	"display_name" text NOT NULL,
	"primary_email" varchar(320),
	"domain" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"relationship_state_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"connector_id" uuid,
	"external_id" varchar(255) NOT NULL,
	"thread_id" varchar(255),
	"message_id" varchar(255),
	"subject" text,
	"snippet" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_item_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"relationship_item_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"connector_id" uuid,
	"external_id" varchar(255) NOT NULL,
	"thread_id" varchar(255),
	"message_id" varchar(255),
	"quote" text,
	"occurred_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"relationship_state_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"text" text NOT NULL,
	"confidence" integer DEFAULT 80 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "relationship_memory_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(50) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"bootstrap_status" varchar(32) DEFAULT 'idle' NOT NULL,
	"last_sync_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"relationship_type" varchar(80) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"last_interaction_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(64) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"dedupe_key" varchar(512) NOT NULL,
	"payload" jsonb NOT NULL,
	"run_after_at" timestamp DEFAULT now() NOT NULL,
	"locked_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationship_interactions" ADD CONSTRAINT "relationship_interactions_relationship_state_id_relationship_states_id_fk" FOREIGN KEY ("relationship_state_id") REFERENCES "public"."relationship_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_interactions" ADD CONSTRAINT "relationship_interactions_entity_id_relationship_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."relationship_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_item_sources" ADD CONSTRAINT "relationship_item_sources_relationship_item_id_relationship_items_id_fk" FOREIGN KEY ("relationship_item_id") REFERENCES "public"."relationship_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_items" ADD CONSTRAINT "relationship_items_relationship_state_id_relationship_states_id_fk" FOREIGN KEY ("relationship_state_id") REFERENCES "public"."relationship_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_states" ADD CONSTRAINT "relationship_states_entity_id_relationship_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."relationship_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationship_entities_identity" ON "relationship_entities" USING btree ("org_id","user_id","identity_key");--> statement-breakpoint
CREATE INDEX "idx_relationship_entities_scope_type" ON "relationship_entities" USING btree ("org_id","user_id","type");--> statement-breakpoint
CREATE INDEX "idx_relationship_entities_email" ON "relationship_entities" USING btree ("org_id","user_id","primary_email");--> statement-breakpoint
CREATE INDEX "idx_relationship_entities_domain" ON "relationship_entities" USING btree ("org_id","user_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationship_interactions_external" ON "relationship_interactions" USING btree ("relationship_state_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_relationship_interactions_state_occurred" ON "relationship_interactions" USING btree ("relationship_state_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationship_item_sources_external" ON "relationship_item_sources" USING btree ("relationship_item_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_relationship_item_sources_scope_provider" ON "relationship_item_sources" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_relationship_items_state_kind" ON "relationship_items" USING btree ("relationship_state_id","kind");--> statement-breakpoint
CREATE INDEX "idx_relationship_items_scope_kind" ON "relationship_items" USING btree ("org_id","user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationship_memory_settings_provider" ON "relationship_memory_settings" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_relationship_memory_settings_enabled" ON "relationship_memory_settings" USING btree ("provider","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationship_states_entity" ON "relationship_states" USING btree ("org_id","user_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_relationship_states_scope_status" ON "relationship_states" USING btree ("org_id","user_id","status");--> statement-breakpoint
CREATE INDEX "idx_relationship_states_last_interaction" ON "relationship_states" USING btree ("org_id","user_id","last_interaction_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationship_sync_jobs_dedupe" ON "relationship_sync_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_relationship_sync_jobs_pending" ON "relationship_sync_jobs" USING btree ("status","run_after_at");--> statement-breakpoint
CREATE INDEX "idx_relationship_sync_jobs_scope_provider" ON "relationship_sync_jobs" USING btree ("org_id","user_id","provider");