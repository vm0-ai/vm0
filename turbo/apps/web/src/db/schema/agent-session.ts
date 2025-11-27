import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { agentConfigs } from "./agent-config";
import { conversations } from "./conversation";

/**
 * Agent Sessions table
 * VM0's concept of a persistent running context across multiple runs
 * Unlike checkpoints (immutable snapshots), sessions track the latest state
 */
export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  agentConfigId: uuid("agent_config_id")
    .references(() => agentConfigs.id, { onDelete: "cascade" })
    .notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  artifactName: varchar("artifact_name", { length: 255 }).notNull(),
  templateVars: jsonb("template_vars").$type<Record<string, string>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
