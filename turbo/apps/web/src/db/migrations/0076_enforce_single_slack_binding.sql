-- Delete duplicate bindings per user link (keep the most recently created one)
DELETE FROM "slack_bindings" a
  USING "slack_bindings" b
  WHERE a."slack_user_link_id" = b."slack_user_link_id"
    AND a."slack_user_link_id" IS NOT NULL
    AND a."created_at" < b."created_at";

-- Drop the description column (was used for LLM routing disambiguation)
ALTER TABLE "slack_bindings" DROP COLUMN "description";

-- Drop the old unique index (slack_user_link_id, agent_name)
DROP INDEX "idx_slack_bindings_user_agent";

-- Create new unique index on slack_user_link_id alone (enforces single binding per user link)
-- PostgreSQL unique indexes allow multiple NULLs, so orphaned bindings are unaffected
CREATE UNIQUE INDEX "idx_slack_bindings_user_link_unique" ON "slack_bindings" ("slack_user_link_id");
