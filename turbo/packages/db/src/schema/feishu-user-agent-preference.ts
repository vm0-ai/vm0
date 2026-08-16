import {
  pgTable,
  primaryKey,
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
    vm0UserId: text("vm0_user_id").notNull(),
    userId: text("user_id"),
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
        name: "feishu_user_agent_preferences_pkey",
      }),
      uniqueIndex("idx_feishu_user_agent_preferences_user_org").on(
        table.userId,
        table.orgId,
      ),
    ];
  },
);
