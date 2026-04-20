CREATE TABLE "archived_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"task_id" text NOT NULL,
	"task_type" text NOT NULL,
	"archived_run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_archived_task_runs_unique" ON "archived_task_runs" USING btree ("user_id","org_id","task_id","task_type");