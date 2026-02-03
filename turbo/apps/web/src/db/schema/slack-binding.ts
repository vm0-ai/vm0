import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { slackUserLinks } from "./slack-user-link";
import { agentComposes } from "./agent-compose";

/**
 * Slack Bindings table
 * Stores agent configurations for Slack users
 * Each binding allows a user to trigger a specific agent from Slack
 */
export const slackBindings = pgTable(
  "slack_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slackUserLinkId: uuid("slack_user_link_id")
      .notNull()
      .references(() => slackUserLinks.id, { onDelete: "cascade" }),
    composeId: uuid("compose_id")
      .notNull()
      .references(() => agentComposes.id, { onDelete: "cascade" }),
    // User-defined name for the agent in Slack
    agentName: varchar("agent_name", { length: 255 }).notNull(),
    // Description for LLM routing
    description: text("description"),
    // Secrets encrypted with AES-256-GCM
    encryptedSecrets: text("encrypted_secrets"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Agent name unique per user link
    uniqueIndex("idx_slack_bindings_user_agent").on(
      table.slackUserLinkId,
      table.agentName,
    ),
    // Index for looking up bindings by user link
    index("idx_slack_bindings_user_link").on(table.slackUserLinkId),
  ],
);
