import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";

/**
 * Per-user Slack agent preference.
 *
 * Overrides the org default agent for a single user across every Slack
 * workspace they are connected to in that org. A missing row (or
 * selected_agent_id = null) means "use org default".
 */
export const slackUserAgentPreferences = pgTable(
  "slack_user_agent_preferences",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    selectedAgentId: uuid("selected_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);
