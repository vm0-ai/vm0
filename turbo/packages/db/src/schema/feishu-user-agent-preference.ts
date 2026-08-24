import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agentComposes } from "./agent-compose";
import { agents } from "./agent";

/**
 * Per-user Feishu agent preference within an organization.
 *
 * A missing row or null selected compose means the installation default.
 */
export const feishuUserAgentPreferences = pgTable(
  "feishu_user_agent_preferences",
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
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);
