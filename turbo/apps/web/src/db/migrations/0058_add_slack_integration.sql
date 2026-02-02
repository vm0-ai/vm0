-- Slack Installations table
-- Stores workspace-level bot tokens for Slack App installations
CREATE TABLE "slack_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slack_workspace_id" varchar(255) NOT NULL UNIQUE,
  "slack_workspace_name" varchar(255),
  "encrypted_bot_token" text NOT NULL,
  "bot_user_id" varchar(255) NOT NULL,
  "installed_by_slack_user_id" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Slack User Links table
-- Maps Slack users to VM0 users for account linking
CREATE TABLE "slack_user_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slack_user_id" varchar(255) NOT NULL,
  "slack_workspace_id" varchar(255) NOT NULL,
  "vm0_user_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "idx_slack_user_links_user_workspace"
  ON "slack_user_links"("slack_user_id", "slack_workspace_id");

-- Slack Bindings table
-- Stores agent configurations for Slack users
CREATE TABLE "slack_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slack_user_link_id" uuid NOT NULL REFERENCES "slack_user_links"("id") ON DELETE CASCADE,
  "compose_id" uuid NOT NULL REFERENCES "agent_composes"("id") ON DELETE CASCADE,
  "agent_name" varchar(255) NOT NULL,
  "description" text,
  "encrypted_secrets" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "idx_slack_bindings_user_agent"
  ON "slack_bindings"("slack_user_link_id", "agent_name");
CREATE INDEX "idx_slack_bindings_user_link"
  ON "slack_bindings"("slack_user_link_id");

-- Slack Thread Sessions table
-- Maps Slack threads to VM0 agent sessions for conversation continuity
CREATE TABLE "slack_thread_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slack_binding_id" uuid NOT NULL REFERENCES "slack_bindings"("id") ON DELETE CASCADE,
  "slack_channel_id" varchar(255) NOT NULL,
  "slack_thread_ts" varchar(255) NOT NULL,
  "agent_session_id" uuid NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "idx_slack_thread_sessions_thread"
  ON "slack_thread_sessions"("slack_channel_id", "slack_thread_ts");
CREATE INDEX "idx_slack_thread_sessions_binding"
  ON "slack_thread_sessions"("slack_binding_id");
