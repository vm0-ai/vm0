import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  text,
  varchar,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Agent Configs table
 * Stores agent configuration from vm0.config.yaml
 */
export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID
    name: varchar("name", { length: 64 }).notNull(), // Agent name from config
    config: jsonb("config").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userNameIdx: uniqueIndex("idx_agent_configs_user_name").on(
      table.userId,
      table.name,
    ),
  }),
);
