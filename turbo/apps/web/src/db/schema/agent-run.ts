import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentConfigs } from "./agent-config";

/**
 * Agent Runs table
 * Created when developer executes agent via SDK
 */
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(), // Clerk user ID - owner of this run
  agentConfigId: uuid("agent_config_id")
    .references(() => agentConfigs.id)
    .notNull(),
  resumedFromCheckpointId: uuid("resumed_from_checkpoint_id"),
  status: varchar("status", { length: 20 }).notNull(),
  prompt: text("prompt").notNull(),
  dynamicVars: jsonb("dynamic_vars"),
  sandboxId: varchar("sandbox_id", { length: 255 }),
  result: jsonb("result"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});
