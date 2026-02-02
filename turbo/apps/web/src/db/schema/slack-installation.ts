import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Slack Installations table
 * Stores workspace-level bot tokens for Slack App installations
 * One record per Slack workspace
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
  installedBySlackUserId: varchar("installed_by_slack_user_id", {
    length: 255,
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
