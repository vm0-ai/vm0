ALTER TABLE "org_members_cache" ADD COLUMN "pinned_agent_ids" jsonb DEFAULT '[]'::jsonb;
