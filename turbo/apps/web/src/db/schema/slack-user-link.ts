import {
  boolean,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Slack User Links table
 * Maps Slack users to VM0 users for account linking
 * Allows users to interact with VM0 agents via Slack
 */
export const slackUserLinks = pgTable(
  "slack_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slackUserId: varchar("slack_user_id", { length: 255 }).notNull(),
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 }).notNull(),
    // VM0 user ID (Clerk user ID)
    vm0UserId: text("vm0_user_id").notNull(),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Each Slack user can only link to one VM0 user per workspace
    uniqueIndex("idx_slack_user_links_user_workspace").on(
      table.slackUserId,
      table.slackWorkspaceId,
    ),
  ],
);
