import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentComposes } from "./agent-compose";
import { agents } from "./agent";

/**
 * Per-user Slack agent preference.
 *
 * Overrides the org default agent for a single user across every Slack
 * workspace they are connected to in that org. A missing row (or
 * selected_compose_id = null) means "use org default".
 */
export const slackUserAgentPreferences = pgTable(
  "slack_user_agent_preferences",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    selectedComposeId: uuid("selected_compose_id").references(
      () => {
        return agentComposes.id;
      },
      { onDelete: "set null" },
    ),
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
    return [
      primaryKey({ columns: [table.userId, table.orgId] }),
      check(
        "slack_user_agent_preferences_agent_reference_match",
        sql`${table.selectedAgentId} IS NULL OR ${table.selectedAgentId} IS NOT DISTINCT FROM ${table.selectedComposeId}`,
      ),
    ];
  },
);
