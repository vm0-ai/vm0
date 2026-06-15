-- Add schedule_id column to agent_runs to track scheduled runs
ALTER TABLE "agent_runs" ADD COLUMN "schedule_id" uuid;

-- Create agent_schedules table for automated agent runs
CREATE TABLE "agent_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "compose_id" uuid NOT NULL REFERENCES "agent_composes"("id") ON DELETE CASCADE,
  "name" varchar(64) NOT NULL,

  -- Trigger configuration (mutually exclusive)
  "cron_expression" varchar(100),
  "at_time" timestamp,
  "timezone" varchar(50) NOT NULL DEFAULT 'UTC',

  -- What to run
  "prompt" text NOT NULL,
  "vars" jsonb,
  "encrypted_secrets" text,

  -- Artifact configuration
  "artifact_name" varchar(255),
  "artifact_version" varchar(64),
  "volume_versions" jsonb,

  -- State
  "enabled" boolean NOT NULL DEFAULT true,
  "next_run_at" timestamp,
  "last_run_at" timestamp,
  "last_run_id" uuid REFERENCES "agent_runs"("id"),

  -- Timestamps
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),

  -- Constraint: exactly one trigger type (cron XOR at)
  CONSTRAINT "trigger_check" CHECK (
    (cron_expression IS NOT NULL AND at_time IS NULL) OR
    (cron_expression IS NULL AND at_time IS NOT NULL)
  )
);

-- Schedule name unique within agent
CREATE UNIQUE INDEX "idx_agent_schedules_compose_name" ON "agent_schedules"("compose_id", "name");

-- Index for finding schedules by compose
CREATE INDEX "idx_agent_schedules_compose" ON "agent_schedules"("compose_id");

-- Partial index for efficient cron polling: enabled schedules with due next_run_at
CREATE INDEX "idx_agent_schedules_next_run" ON "agent_schedules"("next_run_at")
  WHERE "enabled" = true;
