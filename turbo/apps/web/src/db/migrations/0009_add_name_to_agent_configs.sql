-- Add name column to agent_configs table
ALTER TABLE "agent_configs" ADD COLUMN "name" varchar(64) NOT NULL DEFAULT '';

-- Create unique index on (user_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_configs_user_name" ON "agent_configs" USING btree ("user_id","name");
