import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Agent Run Events table
 * Stores JSONL events from Claude Code
 * NOTE: Not implemented in Phase 1, but defined for future use
 */
export const agentRunEvents = pgTable("agent_run_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => agentRuns.id)
    .notNull(),
  sequenceNumber: integer("sequence_number").notNull(),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  eventData: jsonb("event_data").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
