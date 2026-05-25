-- Add hash column for R2 blob reference
-- Stores SHA-256 hash pointing to JSONL content in R2 blob storage
ALTER TABLE "conversations"
  ADD COLUMN "cli_agent_session_history_hash" VARCHAR(64);

-- Make original TEXT column nullable for new records
-- Existing data remains intact, new records will use hash instead
ALTER TABLE "conversations"
  ALTER COLUMN "cli_agent_session_history" DROP NOT NULL;
