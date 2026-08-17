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
 * Per-user Microsoft Teams agent preference.
 * Overrides the org default agent for a single user across the Teams
 * tenant connected to that org. A missing row means "use org default".
 */
export const teamsUserAgentPreferences = pgTable(
  "teams_user_agent_preferences",
  {
    userId: text("user_id").notNull(),
    // DB/API rollout fallback (observed maximum exposure: ~102 minutes).
    // Remove in #27602 after the switched API is healthy, the previous API
    // version has drained, and every transition invariant remains valid.
    legacyUserId: text("vm0_user_id").notNull(),
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
        columns: [table.legacyUserId, table.orgId],
        name: "teams_user_agent_preferences_pkey",
      }),
      uniqueIndex("idx_teams_user_agent_preferences_user_org").on(
        table.userId,
        table.orgId,
      ),
    ];
  },
);
