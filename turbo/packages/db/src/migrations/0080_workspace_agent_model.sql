-- Migration: Workspace Agent Model (Approach B)
-- Destructive: drops slack_bindings, rewires slack_thread_sessions, adds workspace agent to installations
-- All existing login state is invalidated.

-- 1. Drop slack_thread_sessions (depends on slack_bindings FK)
DROP TABLE IF EXISTS "slack_thread_sessions";

-- 2. Drop slack_bindings entirely
DROP TABLE IF EXISTS "slack_bindings";

-- 3. Invalidate all user links (login state)
DELETE FROM "slack_user_links";

-- 4. Clear existing installations (they lack required new columns)
DELETE FROM "slack_installations";

-- 5. Add new columns to slack_installations
ALTER TABLE "slack_installations"
  ADD COLUMN "default_compose_id" uuid NOT NULL,
  ADD COLUMN "admin_slack_user_id" varchar(255) NOT NULL;

-- 6. Remove old installedBySlackUserId column (replaced by admin_slack_user_id)
ALTER TABLE "slack_installations" DROP COLUMN IF EXISTS "installed_by_slack_user_id";

-- 7. Add FK constraint for default_compose_id
ALTER TABLE "slack_installations"
  ADD CONSTRAINT "slack_installations_default_compose_id_agent_composes_id_fk"
  FOREIGN KEY ("default_compose_id") REFERENCES "agent_composes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 8. Recreate slack_thread_sessions with user_link FK instead of binding FK
CREATE TABLE IF NOT EXISTS "slack_thread_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slack_user_link_id" uuid NOT NULL,
  "slack_channel_id" varchar(255) NOT NULL,
  "slack_thread_ts" varchar(255) NOT NULL,
  "agent_session_id" uuid NOT NULL,
  "last_processed_message_ts" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- 9. Add FK constraints for slack_thread_sessions
ALTER TABLE "slack_thread_sessions"
  ADD CONSTRAINT "slack_thread_sessions_slack_user_link_id_slack_user_links_id_fk"
  FOREIGN KEY ("slack_user_link_id") REFERENCES "slack_user_links"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "slack_thread_sessions"
  ADD CONSTRAINT "slack_thread_sessions_agent_session_id_agent_sessions_id_fk"
  FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 10. Create indexes for slack_thread_sessions
CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_thread_sessions_thread_user_link"
  ON "slack_thread_sessions" ("slack_user_link_id", "slack_channel_id", "slack_thread_ts");

CREATE INDEX IF NOT EXISTS "idx_slack_thread_sessions_user_link"
  ON "slack_thread_sessions" ("slack_user_link_id");
