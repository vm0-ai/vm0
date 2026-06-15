import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";

/**
 * Per-user official AgentPhone agent preference.
 *
 * A missing row or selected_compose_id = null means "use org default".
 */
export const agentphoneUserAgentPreferences = pgTable(
  "agentphone_user_agent_preferences",
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
        name: "agentphone_user_agent_preferences_pkey",
      }),
    ];
  },
);
