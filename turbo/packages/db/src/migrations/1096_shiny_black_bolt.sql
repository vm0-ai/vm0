CREATE TABLE "run_activity_snapshots" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activity_revision" text DEFAULT 'empty' NOT NULL,
	"message_cursor" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp DEFAULT (now() AT TIME ZONE 'UTC') + interval '24 hours' NOT NULL,
	"summary" text,
	"summary_revision" text,
	"summary_sequence" bigint,
	"summary_message_cursor" bigint,
	"summarized_at" timestamp,
	"next_attempt_at" timestamp,
	"claim_id" uuid,
	"claim_revision" text,
	"claim_expires_at" timestamp,
	CONSTRAINT "run_activity_snapshots_entries_bound" CHECK (jsonb_typeof("run_activity_snapshots"."entries") = 'array' AND jsonb_array_length("run_activity_snapshots"."entries") <= 16 AND octet_length("run_activity_snapshots"."entries"::text) <= 16384)
);
--> statement-breakpoint
ALTER TABLE "run_activity_snapshots" ADD CONSTRAINT "run_activity_snapshots_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_activity_snapshots_expiry_idx" ON "run_activity_snapshots" USING btree ("expires_at","run_id");