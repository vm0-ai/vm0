import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { slackUserLinks } from "./slack-user-link";
import { agentComposes } from "./agent-compose";

/**
 * Slack Bindings table
 * Stores agent configuration for Slack users
 * Each user link can have at most one binding (enforced by unique index)
 */
export const slackBindings = pgTable(
  "slack_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Nullable to support orphaned bindings during logout/login cycle
    slackUserLinkId: uuid("slack_user_link_id").references(
      () => slackUserLinks.id,
      { onDelete: "set null" },
    ),
    // VM0 user ID for restoring bindings after logout/login
    vm0UserId: text("vm0_user_id").notNull(),
    // Slack workspace ID for scoping orphaned bindings lookup
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 }).notNull(),
    composeId: uuid("compose_id")
      .notNull()
      .references(() => agentComposes.id, { onDelete: "cascade" }),
    // User-defined name for the agent in Slack
    agentName: varchar("agent_name", { length: 255 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Enforce single binding per user link
    uniqueIndex("idx_slack_bindings_user_link_unique").on(
      table.slackUserLinkId,
    ),
  ],
);
