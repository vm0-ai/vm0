import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";

/**
 * Per-user Slack agent preference.
 *
 * Overrides the org default agent for a single vm0 user across every Slack
 * workspace they are connected to in that org. A missing row (or
 * selected_compose_id = null) means "use org default".
 */
export const slackUserAgentPreferences = pgTable(
  "slack_user_agent_preferences",
  {
    vm0UserId: text("vm0_user_id").notNull(),
    orgId: text("org_id").notNull(),
    selectedComposeId: uuid("selected_compose_id").references(
      () => {
        return agentComposes.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.vm0UserId, table.orgId],
        name: "slack_user_agent_preferences_pkey",
      }),
    ];
  },
);
