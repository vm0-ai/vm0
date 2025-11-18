import { pgTable, uuid, jsonb, timestamp, text } from "drizzle-orm/pg-core";

/**
 * Agent Configs table
 * Stores agent configuration from vm0.config.yaml
 */
export const agentConfigs = pgTable("agent_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(), // Clerk user ID
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
