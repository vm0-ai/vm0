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
 * Per-user official Telegram agent preference.
 *
 * A missing row or selected_compose_id = null means "use org default".
 * Custom BotFather-created Telegram bots keep using their installation-level
 * default agent and never read this table.
 */
export const telegramUserAgentPreferences = pgTable(
  "telegram_user_agent_preferences",
  {
    userId: text("user_id").notNull(),
    // Temporary compatibility field; remove in #27602 after the Contract gate.
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
        name: "telegram_user_agent_preferences_pkey",
      }),
      uniqueIndex("idx_telegram_user_agent_preferences_user_org").on(
        table.userId,
        table.orgId,
      ),
    ];
  },
);
