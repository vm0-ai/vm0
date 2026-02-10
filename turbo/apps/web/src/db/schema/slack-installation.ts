import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";

/**
 * Slack Installations table
 * Stores workspace-level bot tokens and default agent for Slack App installations
 * One record per Slack workspace. Each workspace has exactly one default agent.
 */
export const slackInstallations = pgTable("slack_installations", {
  id: uuid("id").defaultRandom().primaryKey(),
  slackWorkspaceId: varchar("slack_workspace_id", { length: 255 })
    .notNull()
    .unique(),
  slackWorkspaceName: varchar("slack_workspace_name", { length: 255 }),
  // Bot token encrypted with AES-256-GCM
  encryptedBotToken: text("encrypted_bot_token").notNull(),
  botUserId: varchar("bot_user_id", { length: 255 }).notNull(),
  // Workspace default agent — always set at install time
  defaultComposeId: uuid("default_compose_id")
    .notNull()
    .references(() => agentComposes.id, { onDelete: "restrict" }),
  // Admin: the Slack user who installed the app (can be transferred)
  adminSlackUserId: varchar("admin_slack_user_id", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
