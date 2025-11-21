-- Create agent_checkpoints table
CREATE TABLE "agent_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"parent_checkpoint_id" uuid,
	"session_id" varchar(255) NOT NULL,
	"session_content" text NOT NULL,
	"volume_snapshots" jsonb NOT NULL,
	"working_directory" text NOT NULL,
	"encoded_path" varchar(500) NOT NULL,
	"model" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Add session_id column to agent_runs
ALTER TABLE "agent_runs" ADD COLUMN "session_id" varchar(255);
--> statement-breakpoint

-- Add foreign key constraint
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
