import {
  pgTable,
  primaryKey,
  text,
  timestamp,
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
        name: "telegram_user_agent_preferences_pkey",
      }),
    ];
  },
);
