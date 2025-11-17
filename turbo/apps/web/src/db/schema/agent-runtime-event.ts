import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { agentRuntimes } from "./agent-runtime";

/**
 * Agent Runtime Events table
 * Stores JSONL events from Claude Code
 * NOTE: Not implemented in Phase 1, but defined for future use
 */
export const agentRuntimeEvents = pgTable("agent_runtime_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runtimeId: uuid("runtime_id")
    .references(() => agentRuntimes.id)
    .notNull(),
  sequenceNumber: varchar("sequence_number").notNull(),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  eventData: jsonb("event_data").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
