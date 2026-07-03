CREATE TABLE "storage_version_lineage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_id" uuid NOT NULL,
	"version_id" varchar(64) NOT NULL,
	"parent_version_id" varchar(64) NOT NULL,
	"run_id" uuid NOT NULL,
	"storage_type" varchar(16) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_version_lineage" ADD CONSTRAINT "storage_version_lineage_storage_id_storages_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_version_lineage" ADD CONSTRAINT "storage_version_lineage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_version_lineage_storage_version" ON "storage_version_lineage" USING btree ("storage_id","version_id");--> statement-breakpoint
CREATE INDEX "idx_storage_version_lineage_storage_parent" ON "storage_version_lineage" USING btree ("storage_id","parent_version_id");--> statement-breakpoint
CREATE INDEX "idx_storage_version_lineage_run" ON "storage_version_lineage" USING btree ("run_id");