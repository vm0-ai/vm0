-- Create checkpoints table for storing agent run state snapshots
CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"session_id" varchar(255) NOT NULL,
	"dynamic_vars" jsonb,
	"session_history" text NOT NULL,
	"volume_snapshots" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_agent_config_id_agent_configs_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_configs"("id") ON DELETE no action ON UPDATE no action;
