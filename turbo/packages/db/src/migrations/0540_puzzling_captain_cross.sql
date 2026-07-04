CREATE TABLE "relationship_backfill_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(50) NOT NULL,
	"connector_id" uuid,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"query" text NOT NULL,
	"next_page_token" text,
	"estimated_total" integer,
	"scanned_count" integer DEFAULT 0 NOT NULL,
	"enqueued_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp,
	"last_run_at" timestamp,
	"completed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_relationship_sync_jobs_pending";--> statement-breakpoint
ALTER TABLE "relationship_sync_jobs" ADD COLUMN "priority" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationship_backfill_jobs_provider" ON "relationship_backfill_jobs" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_relationship_backfill_jobs_status" ON "relationship_backfill_jobs" USING btree ("provider","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_relationship_sync_jobs_pending" ON "relationship_sync_jobs" USING btree ("status","priority","run_after_at");