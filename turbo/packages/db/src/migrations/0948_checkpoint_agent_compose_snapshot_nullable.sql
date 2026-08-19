SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE "checkpoints" ALTER COLUMN "agent_compose_snapshot" DROP NOT NULL;
