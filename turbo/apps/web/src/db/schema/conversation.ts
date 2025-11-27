import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Conversations table
 * Stores CLI agent conversation history for checkpoint resumption
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  cliAgentType: varchar("cli_agent_type", { length: 64 }).notNull(),
  cliAgentSessionId: varchar("cli_agent_session_id", { length: 255 }).notNull(),
  cliAgentSessionHistory: text("cli_agent_session_history").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
