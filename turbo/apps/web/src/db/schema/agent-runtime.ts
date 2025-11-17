import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { agentConfigs } from "./agent-config";

/**
 * Agent Runtimes table
 * Created when developer executes agent via SDK
 * NOTE: Not implemented in Phase 1, but defined for future use
 */
export const agentRuntimes = pgTable("agent_runtimes", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentConfigId: uuid("agent_config_id")
    .references(() => agentConfigs.id)
    .notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  prompt: varchar("prompt").notNull(),
  dynamicVars: jsonb("dynamic_vars"),
  sandboxId: varchar("sandbox_id", { length: 255 }),
  result: jsonb("result"),
  error: varchar("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});
