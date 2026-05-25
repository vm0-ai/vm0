CREATE TABLE IF NOT EXISTS "run_uploaded_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" varchar(32) NOT NULL,
	"external_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"filename" text,
	"content_type" text,
	"size_bytes" bigint,
	"url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'run_uploaded_files_run_id_agent_runs_id_fk'
			AND conrelid = 'run_uploaded_files'::regclass
	) THEN
		ALTER TABLE "run_uploaded_files"
			ADD CONSTRAINT "run_uploaded_files_run_id_agent_runs_id_fk"
			FOREIGN KEY ("run_id")
			REFERENCES "public"."agent_runs"("id")
			ON DELETE cascade
			ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_uploaded_files_run" ON "run_uploaded_files" USING btree ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_run_uploaded_files_run_source_external" ON "run_uploaded_files" USING btree ("run_id","source","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_uploaded_files_source_external" ON "run_uploaded_files" USING btree ("source","external_id");
