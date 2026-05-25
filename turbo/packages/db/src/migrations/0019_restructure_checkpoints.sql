-- Migration: Restructure checkpoints table with conversations table
-- This is a BREAKING CHANGE - existing checkpoint data will be lost

-- Step 1: Create conversations table
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"cli_agent_type" varchar(64) NOT NULL,
	"cli_agent_session_id" varchar(255) NOT NULL,
	"cli_agent_session_history" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Step 2: Drop existing checkpoints (breaking change - no data migration)
DROP TABLE IF EXISTS "checkpoints";
--> statement-breakpoint

-- Step 3: Recreate checkpoints table with new schema
CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_config_snapshot" jsonb NOT NULL,
	"artifact_snapshot" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
