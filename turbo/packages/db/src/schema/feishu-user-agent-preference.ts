import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { agentComposes } from "./agent-compose";

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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_feishu_user_agent_preferences_user_org").on(
        table.userId,
        table.orgId,
      ),
    ];
  },
);
