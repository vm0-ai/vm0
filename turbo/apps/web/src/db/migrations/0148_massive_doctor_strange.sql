-- Add org_id column as nullable first (existing rows need backfill)
ALTER TABLE "agent_sessions" ADD COLUMN "org_id" text;--> statement-breakpoint

-- Backfill from run's orgId (runtime org) via conversation chain
UPDATE agent_sessions s
SET org_id = r.org_id
FROM conversations c
JOIN agent_runs r ON c.run_id = r.id
WHERE s.conversation_id = c.id AND s.org_id IS NULL;--> statement-breakpoint

-- Fallback: use compose's orgId for sessions without conversation
UPDATE agent_sessions s
SET org_id = ac.org_id
FROM agent_composes ac
WHERE s.agent_compose_id = ac.id AND s.org_id IS NULL;--> statement-breakpoint

-- Now enforce NOT NULL
ALTER TABLE "agent_sessions" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "idx_agent_sessions_org" ON "agent_sessions" USING btree ("org_id");
