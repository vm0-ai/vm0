import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { apiKeys } from "./api-key";

/**
 * Agent Configs table
 * Stores agent configuration from vm0.config.yaml
 */
export const agentConfigs = pgTable("agent_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiKeyId: uuid("api_key_id")
    .references(() => apiKeys.id)
    .notNull(),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
