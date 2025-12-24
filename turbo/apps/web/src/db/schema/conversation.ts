import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Conversations table
 * Stores CLI agent conversation history for checkpoint resumption
 *
 * Session history storage strategy:
 * - New records use cliAgentSessionHistoryHash (R2 blob reference)
 * - Legacy records use cliAgentSessionHistory (TEXT field)
 * - Read logic: prioritize hash, fallback to TEXT
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  cliAgentType: varchar("cli_agent_type", { length: 64 }).notNull(),
  cliAgentSessionId: varchar("cli_agent_session_id", { length: 255 }).notNull(),
  /** @deprecated Legacy TEXT storage - new records use hash instead */
  cliAgentSessionHistory: text("cli_agent_session_history"),
  /** SHA-256 hash reference to R2 blob storage */
  cliAgentSessionHistoryHash: varchar("cli_agent_session_history_hash", {
    length: 64,
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
